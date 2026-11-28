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
  if(url.pathname.startsWith('/debug/echo')) { const parts=[];for await(const part of req) parts.push(part);const value={path:url.pathname,method:req.method,query:[...url.searchParams],headers:req.headers,body:Buffer.concat(parts).toString()};requests.push(value);return json({received:value,message:'接口调试完成'},422); }
  if(url.pathname.startsWith('/api/')) {
   if(url.pathname==='/api/events'){res.writeHead(200,{'Content-Type':'text/event-stream'});return res.end('retry: 60000\n\n');}
   return json(url.pathname==='/api/status'?{running:true,version:'1.4.21',ip:'127.0.0.1',all_ips:[],device:'Fixture',port:9527}:url.pathname==='/api/room/status'?{isActive:false}:{rooms:[],files:[],messages:[],members:[],count:0});
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
   // Verify welcome sidebar state renders cleanly without legacy VTO paste box.
   assert.equal(await page.locator('#apiImport').count(), 0);
   await page.locator('#apiCatalogWelcome:not([hidden])').waitFor();
   assert(await page.locator('#apiPickDir').isVisible());
   assert(await page.locator('#apiPickFile').isVisible());

   // Upload Spring Boot project files and verify catalog + smart mock + inline path param editing.
   await page.locator('#apiFileInput').setInputFiles([
    { name: 'application.yml', mimeType: 'text/yaml', buffer: Buffer.from('server:\n  port: ' + server.address().port + '\n  servlet:\n    context-path: /debug\n') },
    { name: 'EchoReq.java', mimeType: 'text/plain', buffer: Buffer.from('package com.demo;\npublic class EchoReq {\n  @Schema(example = "C900")\n  private String code;\n  private String contactEmail;\n  private int qty;\n}\n') },
    { name: 'EchoController.java', mimeType: 'text/plain', buffer: Buffer.from('package com.demo;\n@RestController\n@Tag(name = "调试分组")\npublic class EchoController {\n  @PostMapping("/echo/{itemId}")\n  public String sendEcho(@PathVariable("itemId") Long itemId, @RequestParam(defaultValue = "auto") String mode, @RequestHeader("X-Suite") String suite, @RequestBody EchoReq req) { return "ok"; }\n  @GetMapping("/echo")\n  public String ping(@RequestParam String pingKey, @RequestParam String pingKey2) { return "ok"; }\n}\n') },
   ]);
   await page.locator('#apiCatalogLoaded:not([hidden])').waitFor();
   await page.waitForFunction(() => document.querySelectorAll('.api-endpoint-item').length === 2);
   assert.equal(await page.locator('#apiCatalogCount').innerText(), '2');
   await page.locator('[data-api-method-filter="POST"]').click();
   await page.waitForFunction(() => document.querySelectorAll('.api-endpoint-item').length === 1);
   await page.locator('[data-api-method-filter="ALL"]').click();
   await page.locator('#apiCatalogSearch').fill('sendEcho');
   await page.waitForFunction(() => document.querySelectorAll('.api-endpoint-item').length === 1);
   await page.locator('.api-endpoint-item').first().click();

   assert.equal(await page.locator('#apiMethod').inputValue(), 'POST');
   assert.equal(await page.locator('#apiUrl').inputValue(), base + '/debug/echo/1001');
   assert.equal(await page.locator('#apiQueryBadge').innerText(), '1');
   assert.equal(await page.locator('#apiHeaderBadge').innerText(), '1');
   assert.equal(await page.locator('#apiBodyBadge').innerText(), 'JSON');

   // Live inline path-param chip editing updates URL immediately.
   const pathChip = page.locator('.api-path-param-chip input').first();
   await pathChip.fill('8848');
   assert.equal(await page.locator('#apiUrl').inputValue(), base + '/debug/echo/8848');

   const smartBody = JSON.parse(await page.locator('#apiBody').inputValue());
   assert.equal(smartBody.code, 'C900');
   assert.equal(smartBody.contactEmail, 'demo@example.com');
   assert.equal(smartBody.qty, 10);

   await page.locator('#apiMockMode').selectOption('empty');
   assert.equal(JSON.parse(await page.locator('#apiBody').inputValue()).code, '');
   await page.locator('#apiMockMode').selectOption('smart');
   await page.locator('#apiRemock').click();
   assert.equal(JSON.parse(await page.locator('#apiBody').inputValue()).qty, 11);

   await page.locator('#apiSend').click();
   await page.waitForFunction(() => document.querySelector('#apiStatus').textContent.startsWith('422'));
   assert.match(await page.locator('#apiResponseBody').innerText(),/接口调试完成/);
   assert.equal(JSON.parse(requests.at(-1).body).code, 'C900');
   assert.deepEqual(requests.at(-1).query, [['mode', 'auto']]);
   assert.equal(await page.locator('#apiHistoryCount').innerText(), '1');
   assert.equal(await page.locator('.api-history-item').count(), 1);

   // Pasting a cURL command into URL populates request cleanly.
   await page.locator('#apiUrl').evaluate(el => {
    const data = new DataTransfer();
    data.setData('text/plain', `curl -X PUT '${el.value.split('/debug')[0]}/debug/echo/curl?q=one&q=two' -H 'Content-Type: application/json' --data-raw '{"name":"柜体"}'`);
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
   });
   assert.equal(await page.locator('#apiMethod').inputValue(), 'PUT');
   assert.equal(JSON.parse(await page.locator('#apiBody').inputValue()).name, '柜体');

   await page.locator('[data-tool="tab-json"]').click();await page.locator('[data-tool="tab-api"]').click();assert.match(await page.locator('#apiBody').inputValue(),/柜体/);
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
  console.log('API Studio UI passed: two-pane catalog, project/DTO scan, inline path params, smart/empty mock, real 422 response, cURL paste, history, CSP, native adapter, responsive layouts.');
 }finally{await browser.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
