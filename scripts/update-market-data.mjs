import fs from 'node:fs/promises';
const FILE='data/history.json';
const symbols={vix:'%5EVIX',dxy:'DX-Y.NYB',usdtwd:'TWD%3DX',gold:'GC%3DF',us10y:'%5ETNX',us30y:'%5ETYX',wti:'CL%3DF'};
async function yahoo(symbol){const u=`https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?range=5d&interval=1d`;const r=await fetch(u,{headers:{'User-Agent':'Mozilla/5.0'}});if(!r.ok)throw new Error(`Yahoo ${symbol}: ${r.status}`);const j=await r.json(),x=j.chart?.result?.[0];const closes=x?.indicators?.quote?.[0]?.close||[];return [...closes].reverse().find(Number.isFinite)??null;}
async function treasury2y(){const year=new Date().getUTCFullYear();const u=`https://home.treasury.gov/resource-center/data-chart-center/interest-rates/pages/xml?data=daily_treasury_yield_curve&field_tdr_date_value=${year}`;const r=await fetch(u,{headers:{'User-Agent':'market-risk-dashboard/1.0'}});if(!r.ok)return null;const t=await r.text();const vals=[...t.matchAll(/<d:BC_2YEAR[^>]*>([0-9.]+)<\/d:BC_2YEAR>/g)].map(m=>Number(m[1]));return vals.at(-1)??null;}
async function safe(fn,name){try{return await fn()}catch(e){console.warn(name,e.message);return null}}
const old=JSON.parse(await fs.readFile(FILE,'utf8'));
const previous=old.records?.at(-1)?.values||{};
const values={...previous};
await Promise.all(Object.entries(symbols).map(async([k,s])=>{const v=await safe(()=>yahoo(s),k);if(Number.isFinite(v))values[k]=v;}));
const y2=await safe(treasury2y,'us2y');if(Number.isFinite(y2))values.us2y=y2;
// putCall / marginMaintenance / foreignFutures deliberately remain unset until their official-source parsers are verified.
// Never fabricate missing market values. Existing verified values are carried forward only for sources that returned no new quote.
const now=new Date();const date=new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Taipei',year:'numeric',month:'2-digit',day:'2-digit'}).format(now);
let records=old.records||[];records=records.filter(x=>x.date!==date);records.push({date,values});records=records.slice(-730);
await fs.writeFile(FILE,JSON.stringify({updatedAt:now.toISOString(),records},null,2)+'\n');
console.log(date,values);