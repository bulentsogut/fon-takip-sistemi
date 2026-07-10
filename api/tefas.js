// Vercel Serverless Function: /api/tefas
// Kullanım:
//   POST /api/tefas?endpoint=fonFiyatBilgiGetir  -> TEFAS fiyat proxy
//   GET  /api/tefas?mode=portfolio&code=TLY      -> hisse dışı portföy kalemleri (varsa normalize eder)

import https from 'node:https';

function setCors(res){
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type, Accept');
}
function cleanCode(code){ return String(code||'').toUpperCase().trim().replace(/[^A-Z0-9]/g,''); }
function toNumber(value){
  if(value===null||value===undefined) return NaN;
  if(typeof value==='number') return value;
  let x=String(value).replace(/&nbsp;/gi,' ').replace(/%/g,'').replace(/TL|₺/gi,'').trim().replace(/\s+/g,'');
  if(!x) return NaN;
  if(x.includes(',') && x.includes('.')) x=x.replace(/\./g,'').replace(',', '.'); else x=x.replace(',', '.');
  return Number.parseFloat(x);
}
function httpsRequest(url, {method='GET', body=null, headers={}}={}){
  return new Promise((resolve,reject)=>{
    const u=new URL(url);
    const opts={method, hostname:u.hostname, path:u.pathname+u.search, port:u.port||443, timeout:20000, headers:{
      'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36',
      'Accept':'application/json,text/plain,*/*',
      'Accept-Language':'tr-TR,tr;q=0.9,en-US;q=0.7,en;q=0.6',
      'Origin':'https://www.tefas.gov.tr',
      'Referer':'https://www.tefas.gov.tr/',
      ...headers
    }};
    const req=https.request(opts,(res)=>{ let data=''; res.setEncoding('utf8'); res.on('data',c=>data+=c); res.on('end',()=>resolve({status:res.statusCode||0,headers:res.headers||{},body:data})); });
    req.on('timeout',()=>req.destroy(new Error('TEFAS request timeout')));
    req.on('error',reject);
    if(body) req.write(body);
    req.end();
  });
}
function normalizePayload(raw){
  let j=raw;
  if(typeof raw==='string') j=JSON.parse(raw||'{}');
  return j.resultList || j.data || j.items || j.result || (Array.isArray(j)?j:[]);
}
async function proxyEndpoint(endpoint, payload){
  const body=JSON.stringify({dil:'TR', ...(payload||{})});
  const candidates=[
    `https://www.tefas.gov.tr/api/DB/${encodeURIComponent(endpoint)}`,
    `https://www.tefas.gov.tr/api/${encodeURIComponent(endpoint)}`,
    `https://www.tefas.gov.tr/api/DB/${endpoint}`
  ];
  const attempts=[];
  for(const url of candidates){
    try{
      const r=await httpsRequest(url,{method:'POST',body,headers:{'Content-Type':'application/json; charset=utf-8','Content-Length':Buffer.byteLength(body)}});
      attempts.push({url,status:r.status,len:(r.body||'').length,contentType:r.headers['content-type']||''});
      if(r.status>=200 && r.status<300){
        try { return {ok:true, data:normalizePayload(r.body), attempts}; } catch(e){ attempts[attempts.length-1].jsonError=e.message; }
      }
    }catch(e){ attempts.push({url,error:e.message}); }
  }
  return {ok:false,data:[],attempts};
}
function normalizeNonStockRows(rows, fundCode){
  const out=[]; const seen=new Set();
  const nonStockKeywords=[
    ['TERSREPO','Ters Repo'], ['TERS REPO','Ters Repo'], ['REPO','Repo'], ['VADELİ','Vadeli Mevduat'], ['VADELI','Vadeli Mevduat'], ['MEVDUAT','Vadeli Mevduat'], ['NAKİT','Nakit'], ['NAKIT','Nakit'], ['PARA PİYASASI','Para Piyasası'], ['PARA PIYASASI','Para Piyasası'], ['LİKİT','Likit'], ['LIKIT','Likit'], ['KATILMA','Katılma Hesabı'], ['BORÇLANMA','Borçlanma Araçları'], ['BORCLANMA','Borçlanma Araçları'], ['TAHVİL','Tahvil'], ['TAHVIL','Tahvil'], ['BONO','Finansman Bonosu'], ['DİĞER','Diğer'], ['DIGER','Diğer']
  ];
  for(const r of rows||[]){
    const text=String(Object.values(r||{}).join(' ')).toUpperCase();
    let matched=null;
    for(const [kw,label] of nonStockKeywords){ if(text.includes(kw)){ matched=label; break; } }
    if(!matched) continue;
    let weight=NaN;
    for(const k of ['oran','ORAN','agirlik','AGIRLIK','portfoyOran','PORTFOY_ORAN','yuzde','YUZDE','percentage','weight']){
      const n=toNumber(r[k]); if(Number.isFinite(n)){ weight=n; break; }
    }
    if(!Number.isFinite(weight) || Math.abs(weight)<0.005 || Math.abs(weight)>100) continue;
    const code=matched.toUpperCase().replace(/İ/g,'I').replace(/Ğ/g,'G').replace(/Ü/g,'U').replace(/Ş/g,'S').replace(/Ö/g,'O').replace(/Ç/g,'C').replace(/[^A-Z0-9]+/g,'-').replace(/^-|-$/g,'');
    if(seen.has(code)) continue; seen.add(code);
    out.push({code,name:matched,weight:Number(weight.toFixed(4)),type:'cash',tip:'cash',source:'TEFAS'});
  }
  out.sort((a,b)=>b.weight-a.weight);
  return out;
}
async function fetchDistribution(code){
  const candidates=['fonPortfoyDagilimGetir','fonPortfoyBilgiGetir','fonVarlikDagilimGetir','fonDagilimGetir'];
  const attempts=[];
  for(const ep of candidates){
    const r=await proxyEndpoint(ep,{fonKodu:code});
    attempts.push({endpoint:ep, ok:r.ok, count:(r.data||[]).length, attempts:r.attempts});
    const h=normalizeNonStockRows(r.data,code);
    if(h.length) return {ok:true, holdings:h, attempts};
  }
  return {ok:false, holdings:[], attempts};
}
export default async function handler(req,res){
  setCors(res);
  if(req.method==='OPTIONS') return res.status(204).end();
  const debug=String(req.query?.debug||'')==='1';
  if(req.method==='POST'){
    let body={};
    try{ body=typeof req.body==='object'&&req.body?req.body:JSON.parse(req.body||'{}'); }catch{}
    const endpoint=String(req.query?.endpoint||'').replace(/[^A-Za-z0-9_]/g,'');
    if(!endpoint) return res.status(400).json({ok:false,error:'Missing endpoint'});
    const r=await proxyEndpoint(endpoint,body);
    return res.status(r.ok?200:502).json(debug?{ok:r.ok,resultList:r.data,attempts:r.attempts}:{resultList:r.data});
  }
  const mode=String(req.query?.mode||'');
  const code=cleanCode(req.query?.code||req.query?.fonKodu||req.query?.kod||'');
  if(mode==='portfolio'){
    if(!code) return res.status(400).json({ok:false,error:'Missing code'});
    const r=await fetchDistribution(code);
    return res.status(200).json({ok:r.ok,source:'tefas-nonstock',code,count:r.holdings.length,holdings:r.holdings,debug:debug?{attempts:r.attempts}:undefined});
  }
  return res.status(400).json({ok:false,error:'Unsupported TEFAS request'});
}
