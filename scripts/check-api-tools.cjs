// Isolated real HTTP fixture; never calls a user's LAN room or production API.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const http = require('node:http'), fs = require('node:fs'), path = require('node:path');
const { apiRequest } = require('../api-debug-client');
async function main() {
 const root = path.resolve('app/src/main/assets/web'), shots = process.env.UI_SCREEN_DIR || '/private/tmp/wenbox-api-ui'; fs.mkdirSync(shots,{recursive:true});
 const requests=[];
 const server=http.createServer(async(req,res)=>{
  const url=new URL(req.url,'http://localhost');
  const json=(value,status=200)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(value));};
  if(url.pathname==='/debug/echo') { const parts=[];for await(const part of req) parts.push(part);const value={method:req.method,query:[...url.searchParams],headers:req.headers,body:Buffer.concat(parts).toString()};requests.push(value);return json({received:value,message:'接口调试完成'},422); }
  if(url.pathname.startsWith('/api/')) {
   if(url.pathname==='/api/events'){res.writeHead(200,{'Content-Type':'text/event-stream'});return res.end('retry: 60000\n\n');}
   return json(url.pathname==='/api/status'?{running:true,version:'1.4.15',ip:'127.0.0.1',all_ips:[],device:'Fixture',port:9527}:url.pathname==='/api/room/status'?{isActive:false}:{rooms:[],files:[],messages:[],members:[],count:0});
  }
  const file=path.join(root,url.pathname==='/'?'index.html':url.pathname);
  if(!file.startsWith(root+path.sep)){res.writeHead(403);return res.end();}
  try {res.writeHead(200,{'Content-Type':{'.html':'text/html','.js':'application/javascript','.css':'text/css','.png':'image/png','.svg':'image/svg+xml'}[path.extname(file)]||'text/plain','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data: blob:; object-src 'none'"});res.end(fs.readFileSync(file));}catch{res.writeHead(404);res.end();}
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const base=`http://127.0.0.1:${server.address().port}`;
 const browser=await chromium.launch({headless:true,executablePath:process.env.BROWSER_EXECUTABLE});
 try {
  for(const native of [false,true]) {
   const page=await browser.newPage({viewport:{width:1440,height:1080}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
   if(native){await page.exposeFunction('fixtureApiRequest',apiRequest);await page.addInitScript(()=>{window.wenboxDesktop={apiRequest:input=>window.fixtureApiRequest(input)};});}
   await page.goto(base); await page.locator('[data-view="view-tools"]').click(); await page.locator('[data-tool="tab-api"]').click();
   await page.locator('#apiSample').click();await page.locator('#apiApply:not([disabled])').waitFor();
   assert.match(await page.locator('#apiPreview').innerText(),/"tierList": \[\]/);
   assert.match(await page.locator('#apiImportStatus').innerText(),/ShelfTierVto/);
   await page.locator('#apiApply').click();assert.equal(await page.locator('#apiMethod').inputValue(),'POST');
   await page.locator('#apiUrl').fill(base+'/debug/echo?q=one&q=two'); await page.locator('#apiBody').fill('{"name":"柜体","code":"C001","tierList":[]}');
   await page.locator('#apiSend').click();await page.waitForFunction(()=>document.querySelector('#apiStatus').textContent.startsWith('422'));
   assert.match(await page.locator('#apiResponseBody').innerText(),/接口调试完成/); assert.equal(requests.at(-1).method,'POST');assert.equal(JSON.parse(requests.at(-1).body).code,'C001');
   assert.deepEqual(requests.at(-1).query,[['q','one'],['q','two']]);
   assert.equal(await page.locator('.api-history-item').count(),1);
   // Direct paste of a Java snippet into an empty Body is transformed without another dialog.
   await page.locator('#apiBody').fill('');await page.locator('#apiBody').evaluate(el=>{const data=new DataTransfer();data.setData('text/plain','String name;\nint count;');el.dispatchEvent(new ClipboardEvent('paste',{clipboardData:data,bubbles:true,cancelable:true}));});
   assert.deepEqual(JSON.parse(await page.locator('#apiBody').inputValue()),{name:'',count:0});
   await page.locator('[data-tool="tab-json"]').click();await page.locator('[data-tool="tab-api"]').click();assert.match(await page.locator('#apiBody').inputValue(),/count/);
   await page.locator('#apiImport').fill('class Request { List<Tier> tierList; } class Tier { int level; String code; }');await page.waitForFunction(()=>document.querySelector('#apiPreview').textContent.includes('"level"'));
   await page.locator('#apiApply').click();assert.deepEqual(JSON.parse(await page.locator('#apiBody').inputValue()),{tierList:[{level:0,code:''}]});
   const countBefore=requests.length;
   await page.locator('#apiImport').fill('private name;');
   await page.waitForFunction(()=>document.querySelector('#apiApply').disabled);
   assert.deepEqual(JSON.parse(await page.locator('#apiBody').inputValue()),{tierList:[{level:0,code:''}]});
   assert.equal(requests.length,countBefore,'imports never send requests');
   await page.locator('#apiSample').click();
   await page.screenshot({path:path.join(shots,`${native?'native':'browser'}-light.png`),fullPage:true});
   await page.evaluate(()=>document.documentElement.dataset.theme='dark'); await page.screenshot({path:path.join(shots,`${native?'native':'browser'}-dark.png`),fullPage:true});
   await page.setViewportSize({width:390,height:844});await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));await page.screenshot({path:path.join(shots,`${native?'native':'browser'}-mobile.png`),fullPage:false});
   assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'mobile overflow');assert.deepEqual(errors,[]);
   await page.close();
  }
  const portable=await browser.newPage();
  await portable.addInitScript(()=>{window.__WENBOX_PORTABLE__=true;});
  await portable.goto(base);
  assert.equal(await portable.locator('[data-view="view-kvm"], #view-kvm').count(),0);
  await portable.locator('[data-view="view-tools"]').click();
  await portable.locator('[data-tool="tab-api"]').click();
  assert(await portable.locator('#apiSend').isVisible());
  await portable.close();
  console.log('API UI passed: field/nested import, direct paste, real 422 HTTP response, duplicate query, history, tabs, CSP, native adapter, responsive layouts.');
 }finally{await browser.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
