import {Session,escapeHTML as esc} from './session.js';
const $=s=>document.querySelector(s),api=new Session();
const chips=n=>Number(n).toLocaleString(undefined,{maximumFractionDigits:1});
const when=n=>new Date(n).toLocaleString(undefined,{dateStyle:'medium',timeStyle:'short'});
let access,offset=0,query='',kind='all',selection=null,saving=false,listVersion=0,detailVersion=0;
function status(message='',error=false){$('#page-status').textContent=message;$('#page-status').classList.toggle('error',error);}
function login(message='Sign in with the owner account to manage users.'){
  access=null;selection=null;$('#admin-workspace').hidden=true;$('#admin-gate').hidden=false;$('#owner-name').textContent='';
  $('#user-editor').innerHTML='';$('#user-list').innerHTML='';status();
  $('#admin-gate').innerHTML=`<h2>Owner sign in</h2><p>${esc(message)}</p><form id="admin-login"><label>Username<input name="username" autocomplete="username" required pattern="[A-Za-z0-9_]{3,20}" maxlength="20" autocapitalize="none" spellcheck="false"></label><label>Password<input name="password" type="password" autocomplete="current-password" required minlength="12" maxlength="128"></label><button>Sign in</button><p class="form-error" role="alert"></p></form>`;
}
async function start(){
  try{
    access=await api.request('/api/admin/access');
    if(!access.allowed){login(access.signedIn?`The account ${access.username} doesn't have owner access. Sign in with the owner account.`:undefined);return;}
    $('#admin-gate').hidden=true;$('#admin-workspace').hidden=false;$('#owner-name').textContent=access.username;status();await list();
  }catch(error){status(error.message,true);}
}
async function list(){
  const version=++listVersion;
  try{
    const result=await api.request(`/api/admin/users?q=${encodeURIComponent(query)}&kind=${kind}&offset=${offset}`);if(version!==listVersion)return;
    $('#user-list').innerHTML=result.users.length?result.users.map(user=>`<button class="user-row" data-user-id="${esc(user.id)}" aria-pressed="${selection?.user.id===user.id}"><span><strong>${esc(user.username||`Guest · ${user.id.slice(0,8)}`)}</strong><small>${esc(user.location)} · ${user.inHand?'In a hand':'Between hands'}</small></span><span class="credits">${chips(user.credits)}<small>credits</small></span></button>`).join(''):'<p class="empty-state">No accounts found.</p>';
    $('#user-total').textContent=result.total?`${offset+1}–${offset+result.users.length} of ${result.total}`:'0 accounts';
    $('#previous-page').disabled=offset===0;$('#next-page').disabled=!result.hasMore;
  }catch(error){if(error.status===401||error.status===403)login('Your owner session ended. Sign in again.');else status(error.message,true);}
}
async function choose(id,scroll=true){
  if(saving)return;const version=++detailVersion;status();$('#user-editor').innerHTML='<p class="empty-state">Loading account…</p>';
  try{
    const result=await api.request(`/api/admin/users/${encodeURIComponent(id)}`);if(version!==detailVersion)return;
    selection=result;renderEditor();document.querySelectorAll('[data-user-id]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.userId===id)));
    if(scroll&&matchMedia('(max-width:740px)').matches)$('#user-editor').scrollIntoView({behavior:matchMedia('(prefers-reduced-motion:reduce)').matches?'instant':'smooth',block:'start'});
  }catch(error){if(error.status===401||error.status===403)login('Your owner session ended. Sign in again.');else $('#user-editor').innerHTML=`<p class="empty-state" role="alert">${esc(error.message)}</p>`;}
}
function renderEditor(message=''){
  const {user,history}=selection;
  $('#user-editor').innerHTML=`<div class="editor-heading"><h2>${esc(user.username||'Guest account')}</h2><button id="reload-account" class="quiet">Reload</button></div><p class="account-meta">${esc(user.location)} · ${user.inHand?'In a hand':'Between hands'}<br>Joined ${esc(when(user.createdAt))}<br><span class="account-id">${esc(user.id)}</span></p>
    <form id="account-editor"><fieldset><label>Username<input name="username" value="${esc(user.username||'')}" pattern="[A-Za-z0-9_]{3,20}" minlength="3" maxlength="20" autocomplete="off" autocapitalize="none" spellcheck="false" ${user.guest?'placeholder="Optional for guests"':'required'}></label>
    <div class="field-help"><label>Credits<input name="credits" type="number" inputmode="decimal" value="${user.credits}" min="0" step="0.5" required ${user.canEditCredits?'':'disabled'}></label>${user.canEditCredits?'':'<p class="help">Credits can be edited after this hand finishes.</p>'}</div>
    <div class="field-help"><label>New password<input name="password" type="password" autocomplete="new-password" minlength="12" maxlength="128" placeholder="Leave blank to keep unchanged"></label><p class="help">At least 12 characters. Setting a password signs this account out on all devices.</p></div><label id="password-confirmation" hidden>Repeat new password<input name="confirmation" type="password" autocomplete="new-password" maxlength="128"></label></fieldset>
    <p class="form-error" role="alert"></p><div class="save-row"><div class="account-actions"><button type="submit">Save changes</button>${user.id!==access.accountId?'<button type="button" id="delete-user" class="danger quiet">Delete user</button>':''}</div><span role="status">${esc(message)}</span></div></form>
    <details class="history"><summary>Recent changes${history.length?` · ${history.length}`:''}</summary>${history.length?`<ol>${history.map(entry=>`<li>${entry.fields.map(field=>field==='password'?'Password reset':field==='credits'?`Credits: ${chips(entry.before.credits)} → ${chips(entry.after.credits)}`:`Username: ${esc(entry.before.username||'Guest')} → ${esc(entry.after.username)}`).join('<br>')}<time>${esc(when(entry.at))}</time></li>`).join('')}</ol>`:'<p>No changes yet.</p>'}</details>
    ${user.id!==access.accountId?`<dialog id="delete-dialog" class="delete-dialog" aria-labelledby="delete-heading"><h2 id="delete-heading">Delete ${esc(user.username||'this guest')}?</h2><p>This permanently removes their account, chips, and saved games.</p><form id="delete-confirmation"><p class="form-error" role="alert"></p><div class="account-actions"><button type="button" id="cancel-delete" class="quiet" autofocus>Cancel</button><button type="submit" class="danger">Delete permanently</button></div></form></dialog>`:''}`;
}
async function removeAccount(){
  const user=selection.user,dialog=$('#delete-dialog'),form=$('#account-editor');saving=true;
  dialog.querySelector('.form-error').textContent='';dialog.querySelectorAll('button').forEach(button=>button.disabled=true);
  form.querySelector('fieldset').disabled=true;form.querySelectorAll('button').forEach(button=>button.disabled=true);$('#reload-account').disabled=true;
  try{
    await api.request(`/api/admin/users/${encodeURIComponent(user.id)}/delete`,{accountId:access.accountId,revision:user.revision,requestId:crypto.randomUUID(),confirmation:user.id});
    dialog.close();selection=null;++detailVersion;offset=0;$('#user-editor').innerHTML='<p class="empty-state">Choose an account to edit its details.</p>';
    status(`${user.username||'Guest account'} deleted.`);await list();$('#user-search input').focus();
  }catch(error){if(error.status===401||error.status===403)login('Your owner session ended. Sign in again.');else dialog.querySelector('.form-error').textContent=error.message;}
  finally{saving=false;if(form.isConnected){form.querySelector('fieldset').disabled=false;form.querySelectorAll('button').forEach(button=>button.disabled=false);$('#reload-account').disabled=false;dialog.querySelectorAll('button').forEach(button=>button.disabled=false);}}
}
document.addEventListener('input',event=>{
  if(event.target.matches('#account-editor input[name=password]')){const confirmation=$('#password-confirmation');confirmation.hidden=!event.target.value;confirmation.querySelector('input').required=!!event.target.value;if(!event.target.value)confirmation.querySelector('input').value='';}
});
document.addEventListener('cancel',event=>{if(event.target.id==='delete-dialog'&&saving)event.preventDefault();},true);
document.addEventListener('click',event=>{
  const button=event.target.closest('button');if(!button||button.disabled||saving)return;
  if(button.dataset.userId)choose(button.dataset.userId);
  if(button.id==='previous-page'){offset=Math.max(0,offset-25);list();}
  if(button.id==='next-page'){offset+=25;list();}
  if(button.id==='reload-account'&&selection)choose(selection.user.id,false);
  if(button.id==='delete-user'&&selection)$('#delete-dialog').showModal();
  if(button.id==='cancel-delete')$('#delete-dialog').close();
});
document.addEventListener('submit',async event=>{
  const form=event.target;event.preventDefault();if(saving)return;
  if(form.id==='user-search'){const data=new FormData(form);query=String(data.get('q'));kind=String(data.get('kind'));offset=0;status();await list();return;}
  if(form.id==='admin-login'){
    const data=Object.fromEntries(new FormData(form));form.querySelector('button').disabled=true;
    try{await api.request('/api/login',data);form.querySelector('[name=password]').value='';await start();}
    catch(error){form.querySelector('.form-error').textContent=error.message;form.querySelector('button').disabled=false;}return;
  }
  if(form.id==='delete-confirmation'&&selection&&access?.allowed){await removeAccount();return;}
  if(form.id!=='account-editor'||!selection||!access?.allowed)return;
  const data=Object.fromEntries(new FormData(form)),user=selection.user,errorBox=form.querySelector('.form-error');errorBox.textContent='';
  const body={accountId:access.accountId,revision:user.revision,requestId:crypto.randomUUID()};
  if(data.username.trim()!==(user.username||''))body.username=data.username.trim();
  if(user.canEditCredits&&Number(data.credits)!==user.credits)body.credits=Number(data.credits);
  if(data.password){if(data.password!==data.confirmation){errorBox.textContent='The new passwords do not match.';return;}body.password=data.password;}
  if(!['username','credits','password'].some(key=>Object.hasOwn(body,key))){errorBox.textContent='Change at least one field before saving.';return;}
  saving=true;form.querySelector('fieldset').disabled=true;form.querySelector('button[type=submit]').disabled=true;$('#reload-account').disabled=true;
  try{
    const result=await api.request(`/api/admin/users/${encodeURIComponent(user.id)}`,body);
    if(result.signedOut){login('Your password was updated. Sign in with the new password.');return;}
    selection=result;if(result.user.id===access.accountId){access.username=result.user.username;$('#owner-name').textContent=access.username;}
    renderEditor('Changes saved.');await list();
  }catch(error){if(error.status===401||error.status===403)login('Your owner session ended. Sign in again.');else errorBox.textContent=error.message;}
  finally{saving=false;if(form.isConnected){form.querySelector('fieldset').disabled=false;form.querySelector('button[type=submit]').disabled=false;$('#reload-account').disabled=false;}}
});
start();
