import test from 'node:test';
import assert from 'node:assert/strict';
import handler from '../api/index.mjs';
import { economics, profitAt } from '../private/economics.mjs';
import { models } from '../lib/models.mjs';
import { readFile } from 'node:fs/promises';

const call=async(path,headers={},method='GET')=>{const res={statusCode:200,headers:{},setHeader(k,v){this.headers[k.toLowerCase()]=v;},end(body){this.body=body;}};await handler({url:path,headers,method},res);return res;};
const publicPaths=['/','/api/models','/app.css','/app.mjs','/economics.mjs','/d3.min.js','/health','/robots.txt','/favicon.svg'];

test('every dashboard asset and model endpoint works without authentication configuration',async()=>{
  for(const key of ['SESSION_SECRET','GOOGLE_CLIENT_ID','GOOGLE_CLIENT_SECRET','APP_ORIGIN']) delete process.env[key];
  for(const path of publicPaths){
    const result=await call(path);
    assert.equal(result.statusCode,200,path);
    assert(result.body.length>0,path);
    assert.equal(result.headers['set-cookie'],undefined);
    assert.equal(result.headers.location,undefined);
    assert.equal(result.headers.vary,undefined);
  }
  assert.match((await call('/')).headers['content-type'],/^text\/html/);
  assert.match((await call('/app.mjs')).headers['content-type'],/^text\/javascript/);
  assert.match((await call('/api/models')).headers['content-type'],/^application\/json/);
});

test('model API serves the public registry only, without account or environment data',async()=>{
  const result=await call('/api/models',{cookie:'__Host-tokenomics-session=expired','oai-authenticated-user-email':'private@example.invalid'});
  assert.deepEqual(JSON.parse(result.body),{models});
  assert.doesNotMatch(result.body,/private@example|SESSION_SECRET|GOOGLE_CLIENT_SECRET/);
  assert.equal(result.headers['set-cookie'],undefined);
});

test('HEAD matches public GET status and content type without a response body',async()=>{
  for(const path of publicPaths){
    const result=await call(path,{},'HEAD'),get=await call(path);
    assert.equal(result.statusCode,get.statusCode,path);
    assert.equal(result.headers['content-type'],get.headers['content-type'],path);
    assert.equal(result.body,undefined,path);
  }
  const missing=await call('/missing',{},'HEAD');
  assert.equal(missing.statusCode,404);
  assert.equal(missing.body,undefined);
});

test('old sign-in bookmarks return to the public homepage without OAuth',async()=>{
  for(const path of ['/signin','/auth/google','/auth/callback?code=old&state=old','/auth/signout']){
    const result=await call(path);
    assert.equal(result.statusCode,303,path);
    assert.equal(result.headers.location,'/');
    assert.equal(result.headers['set-cookie'],undefined);
  }
});

test('non-read methods cannot mutate the app',async()=>{
  for(const method of ['POST','PUT','PATCH','DELETE','OPTIONS']){
    for(const path of ['/','/api/models','/health','/auth/signout']){
      const result=await call(path,{},method);
      assert.equal(result.statusCode,405,method+' '+path);
      assert.equal(result.headers.allow,'GET, HEAD');
      assert.equal(result.headers['set-cookie'],undefined);
    }
  }
});

test('non-allowlisted files and configuration never become public routes',async()=>{
  for(const path of ['/.env.local','/.env','/.vercel/project.json','/.git/config','/private/index.html','/lib/models.mjs','/lib/auth.mjs','/tests/fixtures/agentx-2026-09-30.json','/package.json','/README.md','/toString','/constructor','/__proto__','/%2e%2e/.env.local','/%2eenv.local']){
    const result=await call(path);
    assert.equal(result.statusCode,404,path);
    assert.equal(result.body,'Not found');
  }
});

test('public pages retain browser security headers and allow indexing',async()=>{
  const result=await call('/');
  assert.equal(result.headers['x-content-type-options'],'nosniff');
  assert.equal(result.headers['x-frame-options'],'DENY');
  assert.match(result.headers['content-security-policy'],/default-src 'self'/);
  assert.match(result.headers['strict-transport-security'],/max-age=/);
  assert.equal(result.headers['x-robots-tag'],undefined);
  assert.match((await call('/robots.txt')).body,/Allow: \/\n/);
  assert.doesNotMatch(String(result.body),/noindex|Sign out|account-email|auth\/signout/);
  assert.doesNotMatch(String((await call('/app.mjs')).body),/location.assign|data.user|account-email/);
});

test('benchmark economics reproduce the prior dashboard',()=>{
  const m=models[0],s={...m,gpus:8,hourlyRate:5.5,hours:730,utilization:1,otherMonthlyCost:0,inputPrice:.15,cachedPrice:.003,outputPrice:.6,feeRate:0};
  const e=economics(s);assert.equal(e.rent,32120);assert(Math.abs(e.totalTps-1741428.8885290306)<.001);assert(Math.abs(e.blend-.016581850421812143)<1e-12);assert(Math.abs(e.revenue-75886.449)<2);
  assert(e.breakEvenUtilization>.42&&e.breakEvenUtilization<.43);
  assert.equal(economics({...s,utilization:0}).profit,-32120);assert.equal(economics({...s,utilization:0}).margin,null);
  assert.equal(economics({...s,inputPrice:0,cachedPrice:0,outputPrice:0}).breakEvenUtilization,null);
});
test('chart-first dashboard keeps tooltip and removes the settings and extra tables',async()=>{
  const page=String((await call('/')).body);
  assert.match(page,/id="chart-tooltip"[^>]*role="tooltip" hidden/);
  assert.match(page,/id="heatmap"/);
  assert.match(page,/id="references"/);
  assert.match(page,/<details class="sources">/);
  assert.doesNotMatch(page,/<input\b|<table\b|class="controls"/);
});
test('inspected chart point uses both coordinates and scales the period without changing break-even',()=>{
  const m=models[0],s={...m,gpus:8,hourlyRate:5.5,hours:730,utilization:1,otherMonthlyCost:0,inputPrice:.15,cachedPrice:.003,outputPrice:.6,feeRate:0};
  const e=economics(s),u=.75,p=.02;
  assert.equal(profitAt(s,u,p),e.millionTokensAtFull*u*p-e.rent);
  assert(Math.abs(profitAt(s,.5,e.breakEvenPrice/.5))<1e-8);
  assert.equal(profitAt(s,0,p)*6,-192720);
  assert(profitAt(s,u,p)>profitAt(s,.5,p));
  assert(profitAt(s,u,p)>profitAt(s,u,.01));
});

test('all five model choices keep the eight-B300 rental assumption',()=>{
  assert.deepEqual(models.map(m=>m.id),['deepseek-v41-flash-b300','deepseek-v4-pro-b300','glm-52-b300','glm-53-proxy-b300','kimi-k3-b300']);
  for(const m of models){
    assert.equal(m.hardware,'B300');assert.equal(m.defaultGpuCount,8);assert.equal(m.defaultHourlyRate,5.5);assert.equal(m.defaultHoursPerMonth,730);
    assert(m.cacheHitRate>=0&&m.cacheHitRate<=1);assert(m.inputTpsPerGpu>0&&m.outputTpsPerGpu>0);
    for(const p of m.prices){
      const s={...m,gpus:m.defaultGpuCount,hourlyRate:m.defaultHourlyRate,hours:m.defaultHoursPerMonth,utilization:1,otherMonthlyCost:0,feeRate:0,inputPrice:p.input,cachedPrice:p.cached,outputPrice:p.output};
      const e=economics(s);assert.equal(e.rent,32120);assert.equal(e.rent*6,192720);assert(Number.isFinite(e.blend));assert(Number.isFinite(e.breakEvenUtilization));
      assert(Math.abs(profitAt(s,e.breakEvenUtilization,e.blend))<1e-7);
      assert(Math.abs(e.blend-(m.inputTpsPerGpu*((1-m.cacheHitRate)*p.input+m.cacheHitRate*p.cached)+m.outputTpsPerGpu*p.output)/(m.inputTpsPerGpu+m.outputTpsPerGpu))<1e-12);
    }
  }
});

test('new model capacities match frozen official calculator and actual eight-GPU source rows',async()=>{
  const {snapshots}=JSON.parse(await readFile(new URL('./fixtures/agentx-2026-09-30.json',import.meta.url)));
  for(const snapshot of snapshots){
    const m=models.find(m=>m.id===snapshot.id),c=snapshot.calculator.hardware[0];
    assert.equal(m.sourceApi,snapshot.calculatorUrl);assert.equal(m.inputTpsPerGpu,c.inputThroughput);assert.equal(m.outputTpsPerGpu,c.outputThroughput);assert.equal(m.cacheHitRate,c.cacheHitRate);
    assert.equal(snapshot.calculator.params.target,50);assert.equal(snapshot.calculator.params.percentile,'p90');assert.equal(m.measuredGpuCount,8);
    assert.deepEqual(new Set(m.benchmarkIds),new Set(snapshot.rows.map(r=>r.id)));
    assert.equal(new Set(snapshot.rows.map(r=>r.recipe_fingerprint)).size,1);
    for(const row of snapshot.rows){
      assert.equal(row.hardware,'b300');assert.equal(row.num_decode_gpu,8);assert.equal(row.num_prefill_gpu,8);assert.equal(row.disagg,false);
      assert.equal(row.model,m.benchmarkModel);assert.equal(row.precision,'fp4');assert.equal(row.benchmark_type,'agentic_traces');assert.equal(row.date,m.measuredAt);assert.equal(row.run_url,m.source);
    }
    if(m.capacityKind==='interpolated'){
      assert(c.nearest.below.interactivity<50&&c.nearest.above.interactivity>50);
      for(const neighbor of [c.nearest.below,c.nearest.above])assert(snapshot.rows.some(r=>r.conc===neighbor.concurrency&&Math.abs(r.metrics.tput_per_gpu-neighbor.throughput)<1e-4));
    }else{
      assert.equal(m.capacityKind,'measured');assert(c.clampedBelow);assert.equal(c.concurrency,24);assert(c.nearest.above.interactivity>=50);
    }
  }
});

test('GLM-5.3 is visibly a 5.2 proxy, not a relabeled measurement',()=>{
  const baseline=models.find(m=>m.id==='glm-52-b300'),proxy=models.find(m=>m.id==='glm-53-proxy-b300');
  assert.match(proxy.name,/estimate/);assert.equal(proxy.estimateFrom,'GLM-5.2');assert.equal(proxy.capacityKind,'proxy');assert.equal(proxy.benchmarkModel,'glm5.2');
  for(const key of ['inputTpsPerGpu','outputTpsPerGpu','cacheHitRate','sourceApi','measuredAt'])assert.equal(proxy[key],baseline[key]);
  assert.match(proxy.assumptions,/not a measured GLM-5.3/);assert(proxy.extraSources[0][1].startsWith('https://github.com/zai-org/'));
});

test('current market price references use single live endpoints, not blended provider minima or double discounts',async()=>{
  const {rows}=JSON.parse(await readFile(new URL('./fixtures/prices-2026-09-30.json',import.meta.url)));
  const cases=[['deepseek-v4-pro-b300','deepseek/deepseek-v4-pro-0813',['streamlake','deepseek']],['glm-52-b300','z-ai/glm-5.2',['z-ai/fp8','baidu/fast']],['glm-53-proxy-b300','z-ai/glm-5.3',['z-ai/fp8','atlas-cloud/fp8']],['kimi-k3-b300','moonshotai/kimi-k3',['moonshotai/mxfp4','relace/fp4']]];
  for(const [id,slug,tags] of cases){
    const m=models.find(m=>m.id===id),r=rows.find(r=>r.model===slug);
    tags.forEach((tag,i)=>{
      const endpoint=r.endpoints.find(e=>e.tag===tag),p=m.prices[i];assert.equal(endpoint.status,0);assert(endpoint.contextLength>=1000000);
      for(const [field,wire] of [['input','prompt'],['cached','input_cache_read'],['output','completion']])assert(Math.abs(p[field]-Number(endpoint.pricing[wire])*1e6)<1e-10);
    });
  }
});
