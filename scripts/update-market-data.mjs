import fs from 'node:fs/promises';
const FILE='data/history.json';
const symbols={vix:'%5EVIX',dxy:'DX-Y.NYB',usdtwd:'TWD%3DX',gold:'GC%3DF',us10y:'%5ETNX',us30y:'%5ETYX',wti:'CL%3DF'};
const headers={'User-Agent':'Mozilla/5.0 market-risk-dashboard/1.0','Accept':'application/json,text/plain,*/*'};
const num=v=>{const n=Number(String(v??'').replace(/,/g,'').replace(/%/g,'').trim());return Number.isFinite(n)?n:null};
const pick=(o,names)=>{for(const n of names)if(o?.[n]!=null&&o[n]!=='')return o[n];return null};
const codeOf=o=>String(pick(o,['股票代號','證券代號','Code','SecuritiesCompanyCode','SecuritiesCode'])??'').trim();
const closeOf=o=>num(pick(o,['收盤價','Close','ClosePrice','收盤']));
const marginBalOf=o=>num(pick(o,['融資今日餘額','今日餘額','本日餘額','MarginPurchaseTodayBalance','MarginPurchaseBalance','融資餘額']));
async function json(url){const r=await fetch(url,{headers});if(!r.ok)throw new Error(`${url}: ${r.status}`);return r.json();}
async function yahoo(symbol){for(const host of ['query1.finance.yahoo.com','query2.finance.yahoo.com']){try{const j=await json(`https://${host}/v8/finance/chart/${symbol}?range=1d&interval=1m`);const x=j.chart?.result?.[0],meta=x?.meta,closes=x?.indicators?.quote?.[0]?.close||[];if(Number.isFinite(meta?.regularMarketPrice))return meta.regularMarketPrice;const v=[...closes].reverse().find(Number.isFinite);if(Number.isFinite(v))return v;}catch{}}return null;}
async function treasury2y(){const year=new Date().getUTCFullYear();const r=await fetch(`https://home.treasury.gov/resource-center/data-chart-center/interest-rates/pages/xml?data=daily_treasury_yield_curve&field_tdr_date_value=${year}`,{headers});if(!r.ok)return null;const t=await r.text();const vals=[...t.matchAll(/<d:BC_2YEAR[^>]*>([0-9.]+)<\/d:BC_2YEAR>/g)].map(m=>Number(m[1]));return vals.at(-1)??null;}

// TAIFEX OpenAPI uses ContractCode / Item / OpenInterest(Net).
// The old parser expected translated field names, so it silently returned null.
async function foreignFutures(){
  const rows=await json('https://openapi.taifex.com.tw/v1/MarketDataOfMajorInstitutionalTradersDetailsOfFuturesContractsBytheDate');
  if(!Array.isArray(rows))throw new Error('TAIFEX response is not an array');
  const row=rows.find(x=>String(x.ContractCode??'').trim()==='臺股期貨'&&String(x.Item??'').trim()==='外資及陸資');
  if(!row)throw new Error('TAIFEX 臺股期貨 / 外資及陸資 row not found');
  const value=num(row['OpenInterest(Net)']);
  if(!Number.isFinite(value))throw new Error('TAIFEX OpenInterest(Net) missing');
  console.log(`TAIFEX foreign futures date=${row.Date} net=${value}`);
  return value;
}

function marketValue(marginRows,priceRows){
  const prices=new Map(priceRows.map(r=>[codeOf(r),closeOf(r)]).filter(([c,p])=>c&&Number.isFinite(p)));
  let value=0,matched=0;
  for(const row of marginRows){
    const code=codeOf(row),bal=marginBalOf(row),close=prices.get(code);
    if(!code||!Number.isFinite(bal)||bal<=0||!Number.isFinite(close)||close<=0)continue;
    // MI_MARGN balance is in trading units (1,000 shares). Multiplying balance × close
    // gives thousand TWD, the same unit as the official financing amount below.
    value+=bal*close;
    matched++;
  }
  return {value,matched};
}

async function twseFinancingAmount(){
  const j=await json('https://www.twse.com.tw/exchangeReport/MI_MARGN?response=json&selectType=MS');
  if(j?.stat!=='OK')throw new Error(`TWSE credit statistics unavailable: ${j?.stat??'unknown'}`);
  const rows=j.creditList||j.tables?.find(t=>Array.isArray(t?.data)&&String(t?.title||'').includes('信用交易統計'))?.data||[];
  const row=rows.find(r=>Array.isArray(r)&&String(r[0]).includes('融資金額'));
  const amount=num(row?.[5]);
  if(!Number.isFinite(amount)||amount<=0)throw new Error('TWSE 融資金額今日餘額 missing');
  return {amount,date:String(j.date||'')};
}

// Market-wide financing maintenance ratio is not a TWSE published field.
// Reproducible estimate: Σ(融資今日餘額張數 × 收盤價) / TWSE融資金額今日餘額 × 100.
async function taiwanMarginMaintenance(){
  const [marginRows,priceRows,loan]=await Promise.all([
    json('https://openapi.twse.com.tw/v1/exchangeReport/MI_MARGN'),
    json('https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL'),
    twseFinancingAmount()
  ]);
  if(!Array.isArray(marginRows)||!marginRows.length)throw new Error('TWSE MI_MARGN empty');
  if(!Array.isArray(priceRows)||!priceRows.length)throw new Error('TWSE STOCK_DAY_ALL empty');
  const market=marketValue(marginRows,priceRows);
  if(market.matched<100||market.value<=0)throw new Error(`TWSE margin/price matched rows too low: ${market.matched}`);
  const ratio=market.value/loan.amount*100;
  if(!Number.isFinite(ratio)||ratio<100||ratio>400)throw new Error(`margin ratio sanity check failed: ${ratio}`);
  console.log(`TWSE margin maintenance date=${loan.date||'latest'} matched=${market.matched} ratio=${ratio.toFixed(2)}%`);
  return Number(ratio.toFixed(2));
}

async function safe(fn,name){try{return await fn()}catch(e){console.warn(`${name}: ${e.message}`);return null}}
const old=JSON.parse(await fs.readFile(FILE,'utf8'));
const now=new Date();
const date=new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Taipei',year:'numeric',month:'2-digit',day:'2-digit'}).format(now);
const arkRaw=process.env.ARK_VALUE?.trim();
const arkValue=arkRaw?Number(arkRaw):null;
if(arkRaw&&(!Number.isFinite(arkValue)||arkValue<0||arkValue>100))throw new Error('ARK_VALUE must be between 0 and 100');
let records=old.records||[];
const previous={...(records.at(-1)?.values||{})};
let values={...previous};
if(Number.isFinite(arkValue)){
  values.arkRisk=Number(arkValue.toFixed(2));
  console.log(`Saving Ark risk ${values.arkRisk}% for ${date}`);
}else{
  await Promise.all(Object.entries(symbols).map(async([k,s])=>{const v=await safe(()=>yahoo(s),k);if(Number.isFinite(v))values[k]=v;}));
  const [y2,ff,mm]=await Promise.all([safe(treasury2y,'us2y'),safe(foreignFutures,'foreignFutures'),safe(taiwanMarginMaintenance,'marginMaintenance')]);
  if(Number.isFinite(y2))values.us2y=y2;
  if(Number.isFinite(ff))values.foreignFutures=ff;
  if(Number.isFinite(mm))values.marginMaintenance=mm;
}
const existing=records.find(x=>x.date===date);
if(existing)values={...existing.values,...values};
records=records.filter(x=>x.date!==date);
records.push({date,values});
records=records.slice(-730);
await fs.writeFile(FILE,JSON.stringify({updatedAt:now.toISOString(),records},null,2)+'\n');
console.log(date,values);