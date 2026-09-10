import fs from 'node:fs/promises';
const FILE='data/history.json';
const symbols={vix:'%5EVIX',dxy:'DX-Y.NYB',usdtwd:'TWD%3DX',gold:'GC%3DF',us10y:'%5ETNX',us30y:'%5ETYX',wti:'CL%3DF'};
const headers={'User-Agent':'market-risk-dashboard/1.0','Accept':'application/json,text/plain,*/*'};
const num=v=>{const n=Number(String(v??'').replace(/,/g,'').replace(/%/g,'').trim());return Number.isFinite(n)?n:null};
const pick=(o,names)=>{for(const n of names)if(o?.[n]!=null)return o[n];return null};
async function json(url){const r=await fetch(url,{headers});if(!r.ok)throw new Error(`${url}: ${r.status}`);return r.json();}
async function yahoo(symbol){const j=await json(`https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?range=5d&interval=1d`);const x=j.chart?.result?.[0],closes=x?.indicators?.quote?.[0]?.close||[];return [...closes].reverse().find(Number.isFinite)??null;}
async function treasury2y(){const year=new Date().getUTCFullYear();const u=`https://home.treasury.gov/resource-center/data-chart-center/interest-rates/pages/xml?data=daily_treasury_yield_curve&field_tdr_date_value=${year}`;const r=await fetch(u,{headers});if(!r.ok)return null;const t=await r.text();const vals=[...t.matchAll(/<d:BC_2YEAR[^>]*>([0-9.]+)<\/d:BC_2YEAR>/g)].map(m=>Number(m[1]));return vals.at(-1)??null;}
async function foreignFutures(){const rows=await json('https://openapi.taifex.com.tw/v1/MarketDataOfMajorInstitutionalTradersDetailsOfFuturesContractsBytheDate');const row=rows.find(x=>String(pick(x,['商品名稱','商品名称','ProductName'])||'').includes('臺股期貨')&&String(pick(x,['身份別','身分別','Identity'])||'').includes('外資'));if(!row)return null;return num(pick(row,['多空未平倉口數淨額','多空未平倉口數淨額(口)','OpenInterestNet','未平倉餘額多空淨額']));}
async function taiwanMarginMaintenance(){
  // TWSE/TPEx do not publish one official market-wide maintenance-ratio field.
  // Prefer an explicitly published aggregate ratio if an official endpoint adds one; otherwise keep the last verified estimate.
  const [twse,tpex]=await Promise.all([
    json('https://openapi.twse.com.tw/v1/exchangeReport/MI_MARGN').catch(()=>[]),
    json('https://www.tpex.org.tw/openapi/v1/tpex_mainboard_margin_balance').catch(()=>[])
  ]);
  console.log(`TWSE margin rows=${Array.isArray(twse)?twse.length:0}, TPEx margin rows=${Array.isArray(tpex)?tpex.length:0}`);
  return null;
}
async function safe(fn,name){try{return await fn()}catch(e){console.warn(name,e.message);return null}}
const old=JSON.parse(await fs.readFile(FILE,'utf8'));
const previous=old.records?.at(-1)?.values||{};
const values={...previous};
await Promise.all(Object.entries(symbols).map(async([k,s])=>{const v=await safe(()=>yahoo(s),k);if(Number.isFinite(v))values[k]=v;}));
const [y2,ff,mm]=await Promise.all([safe(treasury2y,'us2y'),safe(foreignFutures,'foreignFutures'),safe(taiwanMarginMaintenance,'marginMaintenance')]);
if(Number.isFinite(y2))values.us2y=y2;
if(Number.isFinite(ff))values.foreignFutures=ff;
if(Number.isFinite(mm))values.marginMaintenance=mm;
// marginMaintenance remains the last verified market estimate until a reproducible aggregate calculator is available.
// Never fabricate missing values. Official TAIFEX data is used for foreignFutures.
const now=new Date();const date=new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Taipei',year:'numeric',month:'2-digit',day:'2-digit'}).format(now);
let records=old.records||[];records=records.filter(x=>x.date!==date);records.push({date,values});records=records.slice(-730);
await fs.writeFile(FILE,JSON.stringify({updatedAt:now.toISOString(),records},null,2)+'\n');
console.log(date,values);