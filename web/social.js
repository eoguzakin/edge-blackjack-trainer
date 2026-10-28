import {escapeHTML as esc} from './session.js';
const $=s=>document.querySelector(s);
export class SocialControls{
  constructor(table){
    this.table=table;this.authMode='register';this.dialog=$('#social-dialog');this.error='';this.pending=false;this.admin=false;this.adminFor=null;
    $('#account-button').addEventListener('click',()=>this.open('account'));
    $('#friends-button').addEventListener('click',()=>this.open('friends'));
    this.dialog.addEventListener('click',e=>{const b=e.target.closest('button');if(!b)return;if(b.dataset.close!==undefined)this.dialog.close();if(b.dataset.authMode){this.authMode=b.dataset.authMode;this.error='';this.render();}if(b.id==='sign-out')this.logout();if(b.id==='leave-table')this.command('leave');if(b.id==='copy-invite')this.copy();});
    this.dialog.addEventListener('submit',e=>{e.preventDefault();this.submit(e.target);});
    const invite=new URLSearchParams(location.search).get('invite');this.invite=/^[A-Z2-9]{8}$/i.test(invite||'')?invite.toUpperCase():'';
  }
  open(view){if(!this.table.connected)return;this.view=view;this.error='';this.render();if(!this.dialog.open)this.dialog.showModal();}
  update(){
    const data=this.table.api.data;$('#account-button').textContent=data?.user.username||'Save account';$('#friends-button').textContent=data?.room?'Your table':'Friends';
    if(data&&this.adminFor!==data.user.id){
      const id=data.user.id;this.adminFor=id;this.admin=false;
      this.table.api.request('/api/admin/access').then(access=>{if(this.adminFor===id){this.admin=access.allowed;if(this.dialog.open&&this.view==='account'&&!this.pending&&!this.dialog.querySelector('form'))this.render();}}).catch(()=>{});
    }
    if(this.invite&&!this.openedInvite&&data){this.openedInvite=true;this.open('friends');}
    if(this.dialog.open&&!this.pending&&!this.dialog.contains(document.activeElement))this.render();
  }
  render(){
    const data=this.table.api.data;if(!data)return;const {user,room}=data;
    const heading=this.view==='friends'?'Friends at your table':user.guest?'Keep your seat':user.username;
    let content='';
    if(user.guest){
      content=`<p class="dialog-note">${this.view==='friends'?'Choose an account to create or join a table.':'Your chips are saved in this browser. Add an account to take them with you.'}</p><div class="auth-tabs"><button data-auth-mode="register" aria-pressed="${this.authMode==='register'}">Create account</button><button data-auth-mode="login" aria-pressed="${this.authMode==='login'}">Sign in</button></div><form id="auth-form"><label>Username<input name="username" autocomplete="username" pattern="[A-Za-z0-9_]{3,20}" minlength="3" maxlength="20" required autocapitalize="none" spellcheck="false"></label><label>Password<input name="password" type="password" autocomplete="${this.authMode==='register'?'new-password':'current-password'}" minlength="12" maxlength="128" required placeholder="At least 12 characters"></label><button class="gold-button" ${this.pending?'disabled':''}>${this.pending?'Saving…':this.authMode==='register'?'Create account':'Sign in'}</button></form>`;
    }else if(this.view==='account'){
      content=`<div class="account-balance"><span>Saved chips</span><strong>${user.bankroll.toLocaleString('en-US')}</strong></div><p class="dialog-note">The same balance follows you between solo and friend tables.</p>${this.admin?'<a class="quiet-button manage-users-link" href="./admin.html">Manage users</a>':''}<button id="sign-out" class="quiet-button" ${this.pending?'disabled':''}>Sign out</button>`;
    }else if(room){
      content=`<div class="invite-card"><span>Invite code</span><strong>${room.code}</strong><button id="copy-invite" class="quiet-button">Copy invite link</button></div><p class="dialog-note">${room.seats} / 5 seats · Minimum ${room.minimum} chips · Host ${esc(room.host)}</p><p class="dialog-note">Choose your bet and press Ready. The host deals when at least two players are ready.</p><button id="leave-table" class="quiet-button" ${this.pending||!['ready','settled'].includes(this.table.game.phase)?'disabled':''}>Leave table</button>`;
    }else{
      content=`<form id="create-room-form"><label>Minimum bet<input name="minimum" type="number" min="1" step="1" max="${Math.floor(user.bankroll)}" value="${Math.min(10,Math.floor(user.bankroll))}" required></label><button class="gold-button" ${this.pending||user.bankroll<1?'disabled':''}>Open a table</button></form><div class="form-divider">or join a friend</div><form id="join-room-form"><label>Invite code<input name="code" class="invite-input" value="${esc(this.invite)}" placeholder="8-character code" autocomplete="off" spellcheck="false" maxlength="12" required></label><button class="quiet-button" ${this.pending?'disabled':''}>Join table</button></form>`;
    }
    this.dialog.innerHTML=`<div class="dialog-heading"><h2>${esc(heading)}</h2><button class="dialog-close" data-close aria-label="Close">×</button></div>${content}<p class="dialog-error" role="alert">${esc(this.error)}</p>`;
  }
  async submit(form){
    if(this.pending)return;const values=Object.fromEntries(new FormData(form));this.pending=true;this.error='';form.querySelector('button[type=submit],button.gold-button,button.quiet-button')?.setAttribute('disabled','');
    try{
      let data;
      if(form.id==='auth-form'){data=await this.table.api.request(this.authMode==='register'?'/api/register':'/api/login',values);this.table.accept(data);this.table.notify(this.authMode==='register'?'Account saved. Your chips came with you.':'Welcome back.');if(this.view!=='friends')this.dialog.close();}
      if(form.id==='create-room-form'||form.id==='join-room-form'){
        data=await this.table.api.action(null,form.id==='create-room-form'?{minimum:Number(values.minimum)}:{code:values.code},form.id==='create-room-form'?'/api/rooms/create':'/api/rooms/join');this.table.accept(data);this.table.bet=data.room.minimum;this.table.render();this.invite='';history.replaceState(null,'',location.pathname+'#main');if(form.id==='join-room-form')this.dialog.close();
      }
    }catch(error){this.error=error.message;if(error.status===409)await this.table.refresh();}
    finally{this.pending=false;if(this.dialog.open)this.render();}
  }
  async command(action){this.pending=true;try{const data=await this.table.api.action(action);this.table.accept(data);this.dialog.close();}catch(error){this.error=error.message;if(error.status===409)await this.table.refresh();}finally{this.pending=false;if(this.dialog.open)this.render();}}
  async logout(){this.pending=true;try{await this.table.api.request('/api/logout',{});this.dialog.close();location.reload();}catch(error){this.error=error.message;this.pending=false;this.render();}}
  async copy(){const room=this.table.api.data.room;if(!room)return;const link=`${location.origin}${location.pathname}?invite=${room.code}#main`;try{await navigator.clipboard.writeText(link);this.table.notify('Invite link copied.');}catch{this.table.notify(`Invite code: ${room.code}`);}}
}
