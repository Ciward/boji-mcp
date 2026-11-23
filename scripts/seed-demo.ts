import { Store } from '../src/store.js';
import { getConfig } from '../src/config.js';
import { join } from 'node:path';
const config=getConfig();if(!process.argv.includes('--confirm-demo'))throw new Error('仅在独立演示数据目录运行：npm run seed:demo -- --confirm-demo');
const store=new Store(join(config.dataDir,'boji.sqlite'),config.timezone);
try{console.log(JSON.stringify(store.createMeal({idempotency_key:'boji-demo-breakfast-v1',meal:{title:'演示：酸奶燕麦',occurred_at:new Date().toISOString(),meal_type:'breakfast',notes:'合成演示数据，请勿当作真实饮食',items:[{name:'演示酸奶燕麦',amount_g:250,consumed_fraction:1,nutrients:{energy_kcal:340,protein_g:18,carbs_g:45,fat_g:10},confidence:'medium',evidence:'manual',notes:'合成数据'}]}}),null,2));}finally{store.close();}
