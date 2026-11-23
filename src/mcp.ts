import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ListToolsRequestSchema, type Tool } from '@modelcontextprotocol/sdk/types.js';
import { toJsonSchemaCompat } from '@modelcontextprotocol/sdk/server/zod-json-schema-compat.js';
import { mcpChallenge } from './auth.js';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { createMealSchema,updateMealSchema,changeStateSchema,dateSchema,recordFoodLibrarySchema,updateFoodLibrarySchema,foodLibrarySearchSchema,AppError } from './model.js';
import type { Store } from './store.js';
import type { HealthService } from './health.js';
type AuthenticatedTool = Tool & { securitySchemes: { type: 'oauth2'; scopes: string[] }[] };
export function createMcp(store:Store,health:HealthService,scopes:string[],resourceMetadata:string) {
  const server=new McpServer({name:'boji-health-mcp',version:'0.2.0'},{instructions:'Boji 是个人健康账本。先调用 boji_get_context 取得时区/日期。每次餐食记录前先用 boji_search_food_library 搜索个性化库，核对餐厅、规格、做法和参考份量，命中才复用；首次研究后用 boji_record_food_library_item 保存依据和来源。库条目和餐食是独立快照，使用时在food_library_ref写入id和version。食物照片由宿主模型理解；写入整份营养值与 consumed_fraction，服务只乘一次。未知值为null，notes记录假设。重试复用请求idempotency_key；修改前读取version。只有 persisted:true 是保存成功。'});
  const tools: AuthenticatedTool[] = [];
  function register(name:string,title:string,description:string,inputSchema:z.ZodRawShape,write:boolean,handler:(p:any)=>unknown,destructive=false){
    const scope=write?'health.write':'health.read';
    const securitySchemes=[{type:'oauth2' as const,scopes:[scope]}];
    const schema=z.object(inputSchema);
    const metadata={title,description,annotations:{readOnlyHint:!write,destructiveHint:destructive,idempotentHint:true,openWorldHint:false},_meta:{securitySchemes}};
    tools.push({name,...metadata,inputSchema:toJsonSchemaCompat(schema,{strictUnions:true,pipeStrategy:'input'}) as Tool['inputSchema'],securitySchemes} as AuthenticatedTool);
    server.registerTool(name,{...metadata,inputSchema:schema},async params=>{
      if(!scopes.includes(scope)){
        console.info(JSON.stringify({event:'boji.auth',action:'scope_required',tool:name,error:'insufficient_scope',scope}));
        return {isError:true,content:[{type:'text',text:`此连接缺少 ${scope} 权限，需要补充授权后才能继续。`}],_meta:{'mcp/www_authenticate':[mcpChallenge(resourceMetadata,[...scopes,scope],'insufficient_scope')]}};
      }
      try{const output=await handler(params) as Record<string,unknown>;return {content:[{type:'text',text:JSON.stringify(output)}],structuredContent:output};}
      catch(e){const error=e instanceof AppError?{code:e.code,message:e.message,details:e.details}:e instanceof z.ZodError?{code:'invalid_input',message:'输入格式错误',details:e.issues}:{code:'operation_failed',message:'操作未完成，请检查输入或联系维护者。'};return {isError:true,content:[{type:'text',text:JSON.stringify({error})}],structuredContent:{error}};}
    });
  }
  register('boji_get_context','获取健康记录上下文','开始记录前读取当前时间、时区、日期、个性化食物库工作流、营养字段规则和新请求编号。request_key 可用于下一次写入，重试应复用同一编号。',{},false,()=>({...store.context(),request_key:randomUUID()}));
  register('boji_record_meal','记录一餐','记录前先搜索个性化食物库，命中时核对本次份量并附food_library_ref。保存食物与营养估算。nutrients 是整份食物营养，consumed_fraction 由服务器乘一次。未知用null；notes写份量假设。相同idempotency_key只能用于相同内容。返回persisted和meal.id/version。',createMealSchema.shape,true,p=>store.createMeal(p,'mcp'));
  register('boji_get_meal','读取餐食','修改前读取餐食当前版本、营养与删除状态。',{id:z.string().uuid()},false,p=>({meal:store.getMeal(p.id)}));
  register('boji_list_meals','查询餐食日记','按用户本地日期查询餐食，可读取回收站。返回分页items、total。',{date:dateSchema.optional(),deleted:z.boolean().default(false),limit:z.number().int().min(1).max(100).default(30),offset:z.number().int().min(0).default(0)},false,p=>store.listMeals(p.date,p.deleted,p.limit,p.offset));
  register('boji_update_meal','修正餐食','用完整新餐食替换现有内容并保留历史。expected_version来自get_meal；冲突先回读合并，不盲目重试。餐后剩余或同盘另一角度应修订原餐。',{id:z.string().uuid(),...updateMealSchema.shape},true,p=>{const {id,...input}=p;return store.updateMeal(id,input,'mcp');});
  register('boji_delete_meal','移入回收站','用户明确要求删除时，将餐食移入回收站并从汇总排除。可恢复。',{id:z.string().uuid(),...changeStateSchema.shape},true,p=>{const {id,...input}=p;return store.changeState(id,input,false,'mcp');},true);
  register('boji_restore_meal','恢复餐食','恢复回收站餐食并重算汇总。',{id:z.string().uuid(),...changeStateSchema.shape},true,p=>{const {id,...input}=p;return store.changeState(id,input,true,'mcp');});
  register('boji_get_summary','获取日汇总','返回指定本地日已记录营养合计与缺测项、健康来源数据及新鲜度。未记录不是零摄入；不推断总能量消耗或医学结论。',{date:dateSchema},false,p=>({...store.summary(p.date),health:health.dailySummary(p.date)}));
  register('boji_get_source_status','查看健康同步状态','查看已连接来源、最后接收时间和数据覆盖，不触发或保证手机同步。',{},false,()=>health.listSources());
  register('boji_get_trends','获取营养趋势','返回最近1–90天记录与缺测数。无记录日期保持null。',{days:z.number().int().min(1).max(90).default(7)},false,p=>store.trends(p.days));
  register('boji_search_food_library','搜索个性化食物库','按名称、别名、餐厅或规格查找用户确认/核验过的常见食物基线。每次餐食记录前优先搜索。只返回基线，不会自动写入餐食；需核对规格、做法、参考份量和verified_at。',foodLibrarySearchSchema.shape,false,p=>store.searchFoodLibrary(p));
  register('boji_get_food_library_item','读取个性化食物条目','按ID读取食物库当前版本。修改前须读取当前版本。', {id:z.string().uuid()},false,p=>({item:store.getFoodLibraryItem(p.id)}));
  register('boji_record_food_library_item','保存个性化食物条目','保存用户常吃食物或菜品的核验基线、参考份量、营养、来源和不确定性。网络/菜单证据需来源URL；重复身份返回duplicate_food，先搜索并更新已有条目。必须在用户授权的任务中调用。',recordFoodLibrarySchema.shape,true,p=>store.recordFoodLibrary(p,'mcp'));
  register('boji_update_food_library_item','修正个性化食物条目','用完整新内容更新食物库。先读当前version并保留来源。旧餐记录是独立快照，不会随食物库更新而改变。',{id:z.string().uuid(),...updateFoodLibrarySchema.shape},true,p=>{const {id,...input}=p;return store.updateFoodLibrary(id,input,'mcp');});
  register('boji_delete_food_library_item','归档食物库条目','仅用户明确要求移除时归档；不删除历史，也不改变既有餐食记录。',{id:z.string().uuid(),...changeStateSchema.shape},true,p=>{const {id,...input}=p;return store.changeFoodLibraryState(id,input,false,'mcp');},true);
  register('boji_restore_food_library_item','恢复食物库条目','恢复已归档的食物库条目，若相同条目已重新建立则先处理重复。',{id:z.string().uuid(),...changeStateSchema.shape},true,p=>{const {id,...input}=p;return store.changeFoodLibraryState(id,input,true,'mcp');});
  // SDK 1.32's registerTool strips top-level extension fields. Keep SDK validation and
  // execution, and expose ChatGPT's auth descriptor plus its compatibility mirror.
  server.server.setRequestHandler(ListToolsRequestSchema,()=>({tools}));
  return server;
}
