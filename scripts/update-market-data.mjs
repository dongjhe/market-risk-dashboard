import fs from 'node:fs/promises';
const FILE='data/history.json';
const symbols={vix:'%5EVIX',dxy:'DX-Y.NYB',usdtwd:'TWD%3DX',gold:'GC%3DF',us10y:'%5ETNX',us30y:'%5ETYX',wti:'CL%3DF'};
const headers={'User-Agent':'Mozilla/5.0 market-risk-dashboard/1.0','Accept':'application/json,text/plain,*/*'};
const num=v=>{const n=Number(String(v??'').replace(/,/g,'').replace(/%/g,'').trim());return Number.isFinite(n)?n:null};
const pick=(o,names)=>{for(const n of names)if(o?.[n]!=null&&o[n]!=='')return o[n];return null};
const codeOf=o=>String(pick(o,['股票代號','證券代號','Code','SecuritiesCompanyCode','SecuritiesCode'])??'').trim();
const closeOf=o=>num(pick(o,['ClosingPrice','收盤價','Close','ClosePrice','收盤']));
const marginBalOf=o=>num(pick(o,['融資今日餘額','今日餘額','本日餘額','MarginPurchaseTodayBalance','MarginPurchaseBalance','融資餘額']));
async function json(url){const r=await fetch(url,{headers});if(!r.ok)throw new Error(`${url}: ${r.status}`);return r.json();}
function yahooDate(ts,timezone='America/New_York'){return new Intl.DateTimeFormat('sv-SE',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(ts*1000));}
async function yahooDaily(symbol,range='1mo'){
  for(const host of ['query1.finance.yahoo.com','query2.finance.yahoo.com']){
    try{
      const j=await json(`https://${host}/v8/finance/chart/${symbol}?range=${range}&interval=1d&events=history`);
      const x=j.chart?.result?.[0],timestamps=x?.timestamp||[],closes=x?.indicators?.quote?.[0]?.close||[],tz=x?.meta?.exchangeTimezoneName||'America/New_York';
      const rows=timestamps.map((ts,i)=>({date:yahooDate(ts,tz),value:num(closes[i])})).filter(r=>Number.isFinite(r.value));
      if(rows.length)return rows;
    }catch(e){console.warn(`Yahoo ${symbol} ${host}: ${e.message}`);}
  }
  return [];
}
async function treasury2y(){const year=new Date().getUTCFullYear();const r=await fetch(`https://home.treasury.gov/resource-center/data-chart-center/interest-rates/pages/xml?data=daily_treasury_yield_curve&field_tdr_date_value=${year}`,{headers});if(!r.ok)return null;const t=await r.text();const vals=[...t.matchAll(/<d:BC_2YEAR[^>]*>([0-9.]+)<\/d:BC_2YEAR>/g)].map(m=>Number(m[1]));return vals.at(-1)??null;}
async function foreignFutures(){const rows=await json('https://openapi.taifex.com.tw/v1/MarketDataOfMajorInstitutionalTradersDetailsOfFuturesContractsBytheDate');if(!Array.isArray(rows))throw new Error('TAIFEX response is not an array');const row=rows.find(x=>String(x.ContractCode??'').trim()==='臺股期貨'&&String(x.Item??'').trim()==='外資及陸資');if(!row)throw new Error('TAIFEX 臺股期貨 / 外資及陸資 row not found');const value=num(row['OpenInterest(Net)']);if(!Number.isFinite(value))throw new Error('TAIFEX OpenInterest(Net) missing');console.log(`TAIFEX foreign futures date=${row.Date} net=${value}`);return value;}
function marketValue(marginRows,priceRows){const prices=new Map(priceRows.map(r=>[codeOf(r),closeOf(r)]).filter(([c,p])=>c&&Number.isFinite(p)&&p>0));let value=0,matched=0,marginCount=0;for(const row of marginRows){const code=codeOf(row),bal=marginBalOf(row),close=prices.get(code);if(code&&Number.isFinite(bal)&&bal>0)marginCount++;if(!code||!Number.isFinite(bal)||bal<=0||!Number.isFinite(close)||close<=0)continue;value+=bal*close;matched++;}console.log(`TWSE margin rows=${marginRows.length} price rows=${priceRows.length} marginWithBalance=${marginCount} matched=${matched}`);return {value,matched};}
async function twseFinancingAmount(){const j=await json('https://www.twse.com.tw/exchangeReport/MI_MARGN?response=json&selectType=MS');if(j?.stat!=='OK')throw new Error(`TWSE credit statistics unavailable: ${j?.stat??'unknown'}`);const rows=j.creditList||j.tables?.find(t=>Array.isArray(t?.data)&&String(t?.title||'').includes('信用交易統計'))?.data||[];const row=rows.find(r=>Array.isArray(r)&&String(r[0]).includes('融資金額'));const amount=num(row?.[5]);if(!Number.isFinite(amount)||amount<=0)throw new Error('TWSE 融資金額今日餘額 missing');return {amount,date:String(j.date||'')};}
async function taiwanMarginMaintenance(){const [marginRows,priceRows,loan]=await Promise.all([json('https://openapi.twse.com.tw/v1/exchangeReport/MI_MARGN'),json('https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL'),twseFinancingAmount()]);if(!Array.isArray(marginRows)||!marginRows.length)throw new Error('TWSE MI_MARGN empty');if(!Array.isArray(priceRows)||!priceRows.length)throw new Error('TWSE STOCK_DAY_ALL empty');const market=marketValue(marginRows,priceRows);if(market.matched<100||market.value<=0)throw new Error(`TWSE margin/price matched rows too low: ${market.matched}`);const ratio=market.value/loan.amount*100;if(!Number.isFinite(ratio)||ratio<100||ratio>400)throw new Error(`margin ratio sanity check failed: ${ratio}`);console.log(`TWSE margin maintenance date=${loan.date||'latest'} matched=${market.matched} marketValue=${market.value.toFixed(0)} financingAmount=${loan.amount} ratio=${ratio.toFixed(2)}%`);return Number(ratio.toFixed(2));}
async function safe(fn,name){try{return await fn()}catch(e){console.warn(`${name}: ${e.message}`);return null}}
const old=JSON.parse(await fs.readFile(FILE,'utf8'));const now=new Date();const date=new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Taipei',year:'numeric',month:'2-digit',day:'2-digit'}).format(now);const arkRaw=process.env.ARK_VALUE?.trim();const arkValue=arkRaw?Number(arkRaw):null;if(arkRaw&&(!Number.isFinite(arkValue)||arkValue<0||arkValue>100))throw new Error('ARK_VALUE must be between 0 and 100');let records=old.records||[];
if(Number.isFinite(arkValue)){
  const existing=records.find(x=>x.date===date);const values={...(existing?.values||records.at(-1)?.values||{}),arkRisk:Number(arkValue.toFixed(2))};records=records.filter(x=>x.date!==date);records.push({date,values});console.log(`Saving Ark risk ${values.arkRisk}% for ${date}`);
}else{
  // Repair the stored Yahoo-based history on every full refresh. Daily bars are completed exchange-day closes,
  // so old intraday snapshots are replaced with comparable close-to-close observations.
  const yahooSeries=await Promise.all(Object.entries(symbols).map(async([key,symbol])=>[key,await yahooDaily(symbol,'1mo')]));
  const byDate=new Map(records.map(r=>[r.date,{date:r.date,values:{...(r.values||{})}}]));
  for(const [key,rows] of yahooSeries){for(const p of rows){if(!byDate.has(p.date))continue;byDate.get(p.date).values[key]=p.value;}const last=rows.at(-1);if(last)console.log(`Yahoo daily ${key} date=${last.date} close=${last.value}`);}
  records=[...byDate.values()].sort((a,b)=>a.date.localeCompare(b.date));
  const [y2,ff,mm]=await Promise.all([safe(treasury2y,'us2y'),safe(foreignFutures,'foreignFutures'),safe(taiwanMarginMaintenance,'marginMaintenance')]);
  // Taiwan/official latest values retain the dashboard's current-day snapshot behavior for now.
  const existing=records.find(x=>x.date===date);const previous=records.at(-1)?.values||{};const values={...previous,...(existing?.values||{})};
  if(Number.isFinite(y2))values.us2y=y2;if(Number.isFinite(ff))values.foreignFutures=ff;if(Number.isFinite(mm))values.marginMaintenance=mm;
  // Do not copy a live Yahoo quote into today's row. Yahoo fields are written only to their actual completed trading dates above.
  records=records.filter(x=>x.date!==date);records.push({date,values});
}
records=records.sort((a,b)=>a.date.localeCompare(b.date)).slice(-730);await fs.writeFile(FILE,JSON.stringify({updatedAt:now.toISOString(),records},null,2)+'\n');console.log(`Updated ${records.length} records; Yahoo indicators use completed daily closes.`);
