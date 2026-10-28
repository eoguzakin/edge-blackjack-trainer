import {sqliteTable,text,integer,index,check} from 'drizzle-orm/sqlite-core';
import {sql} from 'drizzle-orm';
export const accounts=sqliteTable('accounts',{
  id:text('id').primaryKey(), username:text('username'), usernameKey:text('username_key').unique(),
  passwordHash:text('password_hash'), chips:integer('chips').notNull().default(2000),
  soloState:text('solo_state'), activeRoom:text('active_room'), revision:integer('revision').notNull().default(0),
  lastRequest:text('last_request'),createdAt:integer('created_at').notNull()
},t=>[check('nonnegative_chips',sql`${t.chips} >= 0`)]);
export const sessions=sqliteTable('sessions',{
  tokenHash:text('token_hash').primaryKey(),userId:text('user_id').notNull().references(()=>accounts.id),expires:integer('expires').notNull()
},t=>[index('sessions_user').on(t.userId),index('sessions_expiry').on(t.expires)]);
export const rooms=sqliteTable('rooms',{
  code:text('code').primaryKey(),hostId:text('host_id').notNull(),state:text('state').notNull(),
  revision:integer('revision').notNull().default(0),updatedAt:integer('updated_at').notNull(),lastRequest:text('last_request')
});
export const rateLimits=sqliteTable('rate_limits',{
  key:text('key').primaryKey(),count:integer('count').notNull(),expires:integer('expires').notNull()
},t=>[index('rate_expiry').on(t.expires)]);
// A failed compare-and-swap rolls back the whole D1 batch, including wallets.
export const writeChecks=sqliteTable('write_checks',{
  id:text('id').primaryKey(),ok:integer('ok').notNull()
},t=>[check('atomic_write_conflict',sql`${t.ok} = 1`)]);
export const adminAudit=sqliteTable('admin_audit',{
  id:text('id').primaryKey(),actorId:text('actor_id').notNull().references(()=>accounts.id),
  targetId:text('target_id').notNull().references(()=>accounts.id),changedFields:text('changed_fields').notNull(),
  beforeValue:text('before_value').notNull(),afterValue:text('after_value').notNull(),createdAt:integer('created_at').notNull()
},t=>[index('admin_audit_target_time').on(t.targetId,t.createdAt)]);
