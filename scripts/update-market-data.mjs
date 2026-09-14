import fs from 'node:fs/promises';
const FILE='data/history.json';
const symbols={vix:'%5EVIX',dxy:'DX-Y.NYB',usdtwd:'TWD%3DX',gold:'GC%3DF',wti:'CL%3DF'};
const headers={'User-Agent':'Mozilla/5.0 market-risk-dashboard/1.0','Accept':'application/json,text/plain,*/*'};
const num=v=>{const n=Number(String(v??'').replace(/,/g,'').replace(/%/g,'').trim());return Number.isFinite(n)?n:null};
const pick=(o,names)=>{for(const n of names)if(o?.[n]!=null&&o[n]!=='')return o[n];return null};
const codeOf=o=>String(pick(o,['股票代號','證券代號','Code','SecuritiesCompanyCode','SecuritiesCode'])??'').trim();
const closeOf=o=>num(pick(o,['ClosingPrice','收盤價','Close','ClosePrice','收盤']));
const marginBalOf=o=>num(pick(o,['融資今日餘額','今日餘額','本日餘額','MarginPurchaseTodayBalance','MarginPurchaseBalance','融資餘額']));
async function json(url){const r=await fetch(url,{headers});if(!r.ok)throw new Error(`${url}: ${r.status}`);return r.json();}
function dateInZone(d,timezone){return new Intl.DateTimeFormat('sv-SE',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit'}).format(d);}
function normalizeDate(v){const s=String(v??'').trim();let m=s.match(/^(\d{4})[-\/]?(\d{2})[-\/]?(\d{2})/);if(m)return `${m[1]}-${m[2]}-${m[3]}`;m=s.match(/^(\d{3})[-\/]?(\d{2})[-\/]?(\d{2})/);if(m)return `${Number(m[1])+1911}-${m[2]}-${m[3]}`;return null;}
function yahooDate(ts,timezone='America/New_York'){return dateInZone(new Date(ts*1000),timezone);}
async function yahooDaily(symbol,range='1mo'){
  for(const host of ['query1.finance.yahoo.com','query2.finance.yahoo.com']){
    try{
      const j=await json(`https://${host}/v8/finance/chart/${symbol}?range=${range}&interval=1d&events=history`);
      const x=j.chart?.result?.[0],timestamps=x?.timestamp||[],closes=x?.indicators?.quote?.[0]?.close||[],meta=x?.meta||{};
      const timezone=meta.exchangeTimezoneName||'America/New_York',today=dateInZone(new Date(),timezone);
      const rows=timestamps.map((ts,i)=>({date:yahooDate(ts,timezone),value:num(closes[i])})).filter(r=>Number.isFinite(r.value)&&r.value>0&&r.date<today);
      if(rows.length)return rows;
    }catch(e){console.warn(`Yahoo ${symbol} ${host}: ${e.message}`);}
  }
  return [];
}
function cboeDateParam(date){return date.replaceAll('-','/');}
async function cboeTotalPutCall(date){
  const nyToday=dateInZone(new Date(),'America/New_York');if(date>=nyToday)return null;
  const dow=new Date(`${date}T12:00:00Z`).getUTCDay();if(dow===0||dow===6)return null;
  const r=await fetch(`https://www.cboe.com/markets/us/options/market-statistics/daily?dt=${encodeURIComponent(cboeDateParam(date))}`,{headers:{...headers,Accept:'text/html,application/xhtml+xml'}});if(!r.ok)throw new Error(`Cboe ${date}: ${r.status}`);
  const t=await r.text(),plain=t.replace(/<script[\s\S]*?<\/script>/gi,' ').replace(/<style[\s\S]*?<\/style>/gi,' ').replace(/<[^>]+>/g,' ').replace(/&nbsp;|&#160;/gi,' ').replace(/\s+/g,' ');
  const value=num(plain.match(/TOTAL\s+PUT\s*\/\s*CALL\s+RATIO\s+([0-9]+(?:\.[0-9]+)?)/i)?.[1]);
  if(!Number.isFinite(value)||value<=0||value>10)throw new Error(`Cboe TOTAL PUT/CALL RATIO not found for ${date}`);return Number(value.toFixed(2));
}
async function treasurySeries(){
  const year=new Date().getUTCFullYear(),r=await fetch(`https://home.treasury.gov/resource-center/data-chart-center/interest-rates/pages/xml?data=daily_treasury_yield_curve&field_tdr_date_value=${year}`,{headers});if(!r.ok)throw new Error(`Treasury: ${r.status}`);const t=await r.text();
  const entries=[...t.matchAll(/<entry>([\s\S]*?)<\/entry>/gi)].map(m=>m[1]),out=[];
  for(const e of entries){const date=normalizeDate(e.match(/<d:NEW_DATE[^>]*>([^<]+)<\/d:NEW_DATE>/i)?.[1]||e.match(/<d:Date[^>]*>([^<]+)<\/d:Date>/i)?.[1]);const us2y=num(e.match(/<d:BC_2YEAR[^>]*>([0-9.]+)<\/d:BC_2YEAR>/i)?.[1]),us10y=num(e.match(/<d:BC_10YEAR[^>]*>([0-9.]+)<\/d:BC_10YEAR>/i)?.[1]),us30y=num(e.match(/<d:BC_30YEAR[^>]*>([0-9.]+)<\/d:BC_30YEAR>/i)?.[1]);if(date&&[us2y,us10y,us30y].every(Number.isFinite))out.push({date,us2y,us10y,us30y});}
  if(!out.length)throw new Error('Treasury yield entries not found');return out.sort((a,b)=>a.date.localeCompare(b.date));
}
async function foreignFutures(){const rows=await json('https://openapi.taifex.com.tw/v1/MarketDataOfMajorInstitutionalTradersDetailsOfFuturesContractsBytheDate');if(!Array.isArray(rows))throw new Error('TAIFEX response is not an array');const row=rows.find(x=>String(x.ContractCode??'').trim()==='臺股期貨'&&String(x.Item??'').trim()==='外資及陸資');if(!row)throw new Error('TAIFEX 臺股期貨 / 外資及陸資 row not found');const value=num(row['OpenInterest(Net)']),date=normalizeDate(row.Date);if(!Number.isFinite(value)||!date)throw new Error('TAIFEX value/date missing');console.log(`TAIFEX foreign futures date=${date} net=${value}`);return {date,value};}
function marketValue(marginRows,priceRows){const prices=new Map(priceRows.map(r=>[codeOf(r),closeOf(r)]).filter(([c,p])=>c&&Number.isFinite(p)&&p>0));let value=0,matched=0;for(const row of marginRows){const code=codeOf(row),bal=marginBalOf(row),close=prices.get(code);if(!code||!Number.isFinite(bal)||bal<=0||!Number.isFinite(close)||close<=0)continue;value+=bal*close;matched++;}console.log(`TWSE margin rows=${marginRows.length} price rows=${priceRows.length} matched=${matched}`);return {value,matched};}
async function twseFinancingAmount(){const j=await json('https://www.twse.com.tw/exchangeReport/MI_MARGN?response=json&selectType=MS');if(j?.stat!=='OK')throw new Error(`TWSE credit statistics unavailable: ${j?.stat??'unknown'}`);const rows=j.creditList||j.tables?.find(t=>Array.isArray(t?.data)&&String(t?.title||'').includes('信用交易統計'))?.data||[],row=rows.find(r=>Array.isArray(r)&&String(r[0]).includes('融資金額')),amount=num(row?.[5]),date=normalizeDate(j.date);if(!Number.isFinite(amount)||amount<=0||!date)throw new Error('TWSE financing amount/date missing');return {amount,date};}
async function taiwanMarginMaintenance(){const [marginRows,priceRows,loan]=await Promise.all([json('https://openapi.twse.com.tw/v1/exchangeReport/MI_MARGN'),json('https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL'),twseFinancingAmount()]);if(!Array.isArray(marginRows)||!marginRows.length||!Array.isArray(priceRows)||!priceRows.length)throw new Error('TWSE source data empty');const market=marketValue(marginRows,priceRows);if(market.matched<100||market.value<=0)throw new Error(`TWSE margin/price matched rows too low: ${market.matched}`);const value=market.value/loan.amount*100;if(!Number.isFinite(value)||value<100||value>400)throw new Error(`margin ratio sanity check failed: ${value}`);console.log(`TWSE margin maintenance date=${loan.date} ratio=${value.toFixed(2)}%`);return {date:loan.date,value:Number(value.toFixed(2))};}
async function safe(fn,name){try{return await fn()}catch(e){console.warn(`${name}: ${e.message}`);return null}}
const old=JSON.parse(await fs.readFile(FILE,'utf8')),now=new Date(),today=dateInZone(now,'Asia/Taipei');const arkRaw=process.env.ARK_VALUE?.trim(),arkValue=arkRaw?Number(arkRaw):null;if(arkRaw&&(!Number.isFinite(arkValue)||arkValue<0||arkValue>100))throw new Error('ARK_VALUE must be between 0 and 100');let records=old.records||[];
if(Number.isFinite(arkValue)){
  const existing=records.find(x=>x.date===today);const values={...(existing?.values||{}),arkRisk:Number(arkValue.toFixed(2))};records=records.filter(x=>x.date!==today);records.push({date:today,values});console.log(`Saving Ark risk ${values.arkRisk}% for ${today}`);
}else{
  const byDate=new Map(records.map(r=>[r.date,{date:r.date,values:{...(r.values||{})}}]));const ensure=d=>{if(!byDate.has(d))byDate.set(d,{date:d,values:{}});return byDate.get(d)};
  const yahooSeries=await Promise.all(Object.entries(symbols).map(async([key,symbol])=>[key,await yahooDaily(symbol,'1mo')]));
  for(const [key,rows] of yahooSeries){for(const p of rows)ensure(p.date).values[key]=p.value;const last=rows.at(-1);if(last)console.log(`Yahoo completed ${key} ${last.date}=${last.value}`);}
  const nyToday=dateInZone(now,'America/New_York');await Promise.all([...byDate.values()].map(async rec=>{if(rec.date>=nyToday){delete rec.values.putCall;return;}const dow=new Date(`${rec.date}T12:00:00Z`).getUTCDay();if(dow===0||dow===6){delete rec.values.putCall;return;}const pc=await safe(()=>cboeTotalPutCall(rec.date),`Cboe putCall ${rec.date}`);if(Number.isFinite(pc))rec.values.putCall=pc;else delete rec.values.putCall;}));
  const [treasury,ff,mm]=await Promise.all([safe(treasurySeries,'Treasury yields'),safe(foreignFutures,'foreignFutures'),safe(taiwanMarginMaintenance,'marginMaintenance')]);
  // Treasury is authoritative for 2Y/10Y/30Y; backfill by the Treasury's own observation date.
  if(treasury)for(const p of treasury){const v=ensure(p.date).values;v.us2y=p.us2y;v.us10y=p.us10y;v.us30y=p.us30y;}
  // Remove values accidentally copied onto dates newer than the official source date, then write the official observation.
  if(ff){for(const r of byDate.values())if(r.date>ff.date)delete r.values.foreignFutures;ensure(ff.date).values.foreignFutures=ff.value;}
  if(mm){for(const r of byDate.values())if(r.date>mm.date)delete r.values.marginMaintenance;ensure(mm.date).values.marginMaintenance=mm.value;}
  if(treasury?.length){const last=treasury.at(-1);for(const r of byDate.values())if(r.date>last.date){delete r.values.us2y;delete r.values.us10y;delete r.values.us30y;}}
  // Today's row may exist only for Ark; never synthesize stale market values into it.
  records=[...byDate.values()].filter(r=>Object.keys(r.values).length).sort((a,b)=>a.date.localeCompare(b.date));
}
records=records.sort((a,b)=>a.date.localeCompare(b.date)).slice(-730);await fs.writeFile(FILE,JSON.stringify({updatedAt:now.toISOString(),records},null,2)+'\n');console.log(`Updated ${records.length} records; all official metrics are stored on their source dates.`);
