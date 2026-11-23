import express from 'express';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { z } from 'zod';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { Store } from './store.js';
import { HealthService } from './health.js';
import { createAuth } from './auth.js';
import { createMcp } from './mcp.js';
import { AppError,dateSchema,foodLibrarySearchSchema } from './model.js';
import { publicOrigins, type Config } from './config.js';
export function createApp(config:Config,store=new Store(join(config.dataDir,'boji.sqlite'),config.timezone)) {
  const app=express();app.disable('x-powered-by');
  const origins=publicOrigins(config.publicUrl,config.publicUrlAliases);
  const originsByHost=new Map(origins.map(origin=>[new URL(origin).host,origin]));
  const hosts=new Set([...originsByHost.keys(),`127.0.0.1:${config.port}`,`localhost:${config.port}`]);
  app.use((req,res,next)=>{
    res.set({'X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','X-Frame-Options':'DENY','Cache-Control':'no-store','X-Robots-Tag':'noindex, nofollow, noarchive','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"});
    if(!hosts.has(req.headers.host??''))return res.status(403).json({error:{code:'host_rejected',message:'请求主机不匹配'}});
    const origin=req.get('Origin');const publicProtocol=/^\/(?:\.well-known\/|oauth\/(?:register|token|revoke)$)/.test(req.path);
    const expectedOrigin=originsByHost.get(req.headers.host??'')??`http://${req.headers.host}`;
    if(!publicProtocol && origin && origin!==expectedOrigin)return res.status(403).json({error:{code:'origin_rejected',message:'请求来源不匹配'}});
    next();
  });
  app.use(express.json({limit:'2mb'}));app.use(express.urlencoded({extended:false,limit:'32kb'}));
  const health=new HealthService(store.db,config.timezone);
  const auth=createAuth(app,store.db,{publicUrl:config.publicUrl,publicUrlAliases:config.publicUrlAliases,adminPassword:config.adminPassword});
  app.get('/healthz',(_req,res)=>res.json({ok:true,service:'boji-health-mcp',version:'0.2.0',schema_version:2}));
  app.post('/mcp',auth.requireMcp,async(req,res)=>{
    const mcp=createMcp(store,health,res.locals.auth.scopes,new URL('/.well-known/oauth-protected-resource/mcp',originsByHost.get(req.headers.host??'')??config.publicUrl).href);
    const transport=new StreamableHTTPServerTransport({sessionIdGenerator:undefined,enableJsonResponse:true});
    res.on('close',()=>{void transport.close();void mcp.close();});
    await mcp.connect(transport);await transport.handleRequest(req,res,req.body);
  });
  app.all('/mcp',auth.requireMcp,(_req,res)=>{res.set('Allow','POST');res.status(405).json({error:{code:'method_not_allowed',message:'使用 Streamable HTTP POST'}});});
  const api=express.Router();api.use(auth.requireSession);api.use((req,res,next)=>['GET','HEAD','OPTIONS'].includes(req.method)?next():auth.requireCsrf(req,res,next));
  api.get('/context',(_req,res)=>res.json(store.context()));
  api.get('/meals',(req,res)=>res.json(store.listMeals(req.query.date?dateSchema.parse(req.query.date):undefined,req.query.deleted==='true',Number(req.query.limit??100),Number(req.query.offset??0))));
  api.post('/meals',(req,res)=>res.status(201).json(store.createMeal(req.body)));
  api.get('/meals/:id',(req,res)=>res.json({meal:store.getMeal(req.params.id)}));
  api.put('/meals/:id',(req,res)=>res.json(store.updateMeal(req.params.id,req.body)));
  api.post('/meals/:id/delete',(req,res)=>res.json(store.changeState(req.params.id,req.body,false)));
  api.post('/meals/:id/restore',(req,res)=>res.json(store.changeState(req.params.id,req.body,true)));
  api.get('/meals/:id/history',(req,res)=>res.json(store.history(req.params.id)));
  api.get('/summary',(req,res)=>{const date=dateSchema.parse(req.query.date??store.context().today);res.json({...store.summary(date),health:health.dailySummary(date)});});
  api.get('/trends',(req,res)=>res.json(store.trends(Number(req.query.days??7))));
  api.get('/foods',(req,res)=>res.json(store.searchFoodLibrary(foodLibrarySearchSchema.parse({query:req.query.query??'',kind:req.query.kind,restaurant_name:req.query.restaurant_name,archived:req.query.archived==='true',limit:Number(req.query.limit??20),offset:Number(req.query.offset??0)}))));
  api.post('/foods',(req,res)=>res.status(201).json(store.recordFoodLibrary(req.body)));
  api.get('/foods/:id/history',(req,res)=>res.json(store.foodLibraryHistory(req.params.id)));
  api.get('/foods/:id',(req,res)=>res.json({item:store.getFoodLibraryItem(req.params.id)}));
  api.put('/foods/:id',(req,res)=>res.json(store.updateFoodLibrary(req.params.id,req.body)));
  api.post('/foods/:id/delete',(req,res)=>res.json(store.changeFoodLibraryState(req.params.id,req.body,false)));
  api.post('/foods/:id/restore',(req,res)=>res.json(store.changeFoodLibraryState(req.params.id,req.body,true)));
  api.get('/sources',(_req,res)=>res.json(health.listSources()));
  api.post('/sources',(req,res)=>res.status(201).json(health.createSource(req.body)));
  api.put('/sources/:id/enabled',(req,res)=>res.json({source:health.setSourceEnabled(req.params.id,z.object({enabled:z.boolean()}).strict().parse(req.body).enabled)}));
  api.post('/sources/:id/revoke',(req,res)=>res.json({source:health.revokeSource(req.params.id)}));
  api.post('/sources/:id/import-xml',express.text({type:['application/xml','text/xml'],limit:'20mb'}),(req,res)=>{if(typeof req.body!=='string')throw new AppError(400,'xml_required','以 application/xml 上传解压后的 export.xml');res.json(health.importXml(req.params.id,req.body));});
  api.get('/export',(_req,res)=>{res.set('Content-Disposition','attachment; filename="boji-export.json"');res.json({...store.exportData(),health:health.exportData()});});
  app.use('/api/v1',api);
  app.post('/ingest/v1/:sourceId',(req,res)=>{
    const token=req.get('Authorization')?.match(/^Bearer (.+)$/)?.[1]??'';
    if(!health.authenticateSource(req.params.sourceId,token))throw new AppError(401,'invalid_source_token','来源凭证无效');
    const source=health.listSources().items.find((s:any)=>s.id===req.params.sourceId);
    if(!source)throw new AppError(404,'not_found','来源不存在');
    if(source.kind==='apple_xml')throw new AppError(400,'use_xml_import','XML 请在登录后的数据源页面导入');
    res.json(source.kind==='health_auto_export'?health.ingestAutoExport(source.id,req.body):health.ingestGeneric(source.id,req.body));
  });
  app.use(['/api','/ingest','/oauth','/.well-known'],(_req,res)=>res.status(404).json({error:{code:'not_found',message:'接口不存在'}}));
  if(existsSync(config.webDir)){app.use(express.static(config.webDir,{index:false,maxAge:0}));app.get('/{*path}',(_req,res)=>res.sendFile(join(config.webDir,'index.html')));}
  app.use((err:any,_req:express.Request,res:express.Response,_next:express.NextFunction)=>{
    if(res.headersSent)return;
    if(err instanceof z.ZodError)return res.status(400).json({error:{code:'invalid_input',message:'输入字段不符合要求',details:err.issues}});
    const status=Number.isInteger(err.status)&&err.status>=400&&err.status<500?err.status:500;
    if(status===500)console.error('Boji request failed:',err.name);
    res.status(status).json({error:{code:status===500?'internal_error':err.code??'invalid_request',message:status===500?'服务器暂时无法完成操作':err.message,details:err.details}});
  });
  return {app,store,health};
}
