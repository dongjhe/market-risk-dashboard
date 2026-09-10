import fs from 'node:fs/promises';
const FILE='data/history.json';
const symbols={vix:'%5EVIX',dxy:'DX-Y.NYB',usdtwd:'TWD%3DX',gold:'GC%3DF',us10y:'%5ETNX',us30y:'%5ETYX',wti:'CL%3DF'};
const headers={'User-Agent':'market-risk-dashboard/1.0','Accept':'application/json,text/plain,*/*'};
const num=v=>{const n=Number(String(v??'').replace(/,/g,'').replace(/%/g,'').trim());return Number.isFinite(n)?n:null};
const pick=(o,names)=>{for(const n of names)if(o?.[n]!=null&&o[n]!=='')return o[n];return null};
const codeOf=o=>String(pick(o,['股票代號','證券代號','Code','SecuritiesCompanyCode','SecuritiesCode'])??'').trim();
const closeOf=o=>num(pick(o,['收盤價','Close','ClosePrice','收盤']));
const marginBalOf=o=>num(pick(o,['今日餘額','本日餘額','融資今日餘額','MarginPurchaseTodayBalance','MarginPurchaseBalance','融資餘額']));
async function json(url){const r=await fetch(url,{headers});if(!r.ok)throw new Error(`${url}: ${r.status}`);return r.json();}
async function yahoo(symbol){const j=await json(`https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?range=5d&interval=1d`);const x=j.chart?.result?.[0],closes=x?.indicators?.quote?.[0]?.close||[];return [...closes].reverse().find(Number.isFinite)??null;}
async function treasury2y(){const year=new Date().getUTCFullYear();const u=`https://home.treasury.gov/resource-center/data-chart-center/interest-rates/pages/xml?data=daily_treasury_yield_curve&field_tdr_date_value=${year}`;const r=await fetch(u,{headers});if(!r.ok)return null;const t=await r.text();const vals=[...t.matchAll(/<d:BC_2YEAR[^>]*>([0-9.]+)<\/d:BC_2YEAR>/g)].map(m=>Number(m[1]));return vals.at(-1)??null;}
async function foreignFutures(){const rows=await json('https://openapi.taifex.com.tw/v1/MarketDataOfMajorInstitutionalTradersDetailsOfFuturesContractsBytheDate');const row=rows.find(x=>String(pick(x,['商品名稱','商品名称','ProductName'])||'').includes('臺股期貨')&&String(pick(x,['身份別','身分別','Identity'])||'').includes('外資'));if(!row)return null;return num(pick(row,['多空未平倉口數淨額','多空未平倉口數淨額(口)','OpenInterestNet','未平倉餘額多空淨額']));}
function financingAmount(rows){
  for(const row of rows){
    const label=String(pick(row,['項目','Item','股票代號','證券代號','Code'])??'');
    if(label.includes('融資金額')||label==='TOTAMT'){
      const v=num(pick(row,['今日餘額','本日餘額','TodayBalance','MarginPurchaseTodayBalance','融資餘額']));
      if(Number.isFinite(v))return v*1000; // official aggregate amount is reported in NT$ thousands
    }
  }
  return null;
}
function marketValue(marginRows,priceRows){
  const prices=new Map(priceRows.map(r=>[codeOf(r),closeOf(r)]).filter(([c,p])=>c&&Number.isFinite(p)));
  let value=0,matched=0;
  for(const row of marginRows){
    const code=codeOf(row),bal=marginBalOf(row),close=prices.get(code);
    if(!code||!Number.isFinite(bal)||bal<=0||!Number.isFinite(close))continue;
    // TWSE/TPEx OpenAPI per-security margin balances are shares; value = shares × close price.
    value+=bal*close;matched++;
  }
  return {value,matched};
}
async function taiwanMarginMaintenance(){
  const [twseMargin,tpexMargin,twsePrices,tpexPrices]=await Promise.all([
    json('https://openapi.twse.com.tw/v1/exchangeReport/MI_MARGN'),
    json('https://www.tpex.org.tw/openapi/v1/tpex_mainboard_margin_balance'),
    json('https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL'),
    json('https://www.tpex.org.tw/openapi/v1/tpex_mainboard_daily_close_quotes')
  ]);
  const tm=Array.isArray(twseMargin)?twseMargin:[],gm=Array.isArray(tpexMargin)?tpexMargin:[];
  const tp=Array.isArray(twsePrices)?twsePrices:[],gp=Array.isArray(tpexPrices)?tpexPrices:[];
  const twse=marketValue(tm,tp),tpex=marketValue(gm,gp);
  const twseLoan=financingAmount(tm),tpexLoan=financingAmount(gm);
  const loan=(twseLoan||0)+(tpexLoan||0),market=twse.value+tpex.value;
  console.log('margin calculator',JSON.stringify({twseMatched:twse.matched,tpexMatched:tpex.matched,twseMarketValue:twse.value,tpexMarketValue:tpex.value,twseLoan,tpexLoan}));
  if(!Number.isFinite(loan)||loan<=0||!Number.isFinite(market)||market<=0||twse.matched===0||tpex.matched===0)return null;
  const ratio=market/loan*100;
  // Sanity guard: a parsing/unit change in an upstream API must never overwrite history with nonsense.
  if(ratio<100||ratio>400)throw new Error(`margin ratio sanity check failed: ${ratio}`);
  return Number(ratio.toFixed(2));
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
const now=new Date();const date=new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Taipei',year:'numeric',month:'2-digit',day:'2-digit'}).format(now);
let records=old.records||[];records=records.filter(x=>x.date!==date);records.push({date,values});records=records.slice(-730);
await fs.writeFile(FILE,JSON.stringify({updatedAt:now.toISOString(),records},null,2)+'\n');
console.log(date,values);