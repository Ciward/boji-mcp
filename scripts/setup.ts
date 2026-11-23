import { existsSync,writeFileSync,mkdirSync,chmodSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
if(existsSync('.env')) {console.log('.env 已存在，保留原配置。管理密码位于本地 .env。');}
else{writeFileSync('.env',`BOJI_HOST=127.0.0.1\nBOJI_PORT=8787\nBOJI_PUBLIC_URL=http://127.0.0.1:8787\nBOJI_DATA_DIR=./data\nBOJI_TIMEZONE=Asia/Shanghai\nBOJI_ADMIN_PASSWORD=${randomBytes(24).toString('base64url')}\n`,{mode:0o600});console.log('已生成权限0600的 .env。使用其中的 BOJI_ADMIN_PASSWORD 登录。');}
mkdirSync('data',{recursive:true,mode:0o700});chmodSync('data',0o700);
