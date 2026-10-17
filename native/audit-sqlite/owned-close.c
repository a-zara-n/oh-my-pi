/* Pinned Bun close consumer only: it clears versionDB->db unconditionally and
** uses sqlite3_errstr(rc), never sqlite3_errmsg(freedDb), on a close failure.
** This context holds owned state, not sqlite3/pager/file objects, across normal
** complete teardown. It is never stored on a zombie/deferred connection. */
typedef struct OmpSqliteCloseContext OmpSqliteCloseContext;
struct OmpSqliteCloseContext {
  OmpSqliteState *states[SQLITE_MAX_ATTACHED+2];
  int count;
  int result;
};
static void ompSqliteCloseCapture(sqlite3 *db, OmpSqliteCloseContext *context){
  int i;
  for(i=0; i<db->nDb; i++){
    Btree *bt=db->aDb[i].pBt;
    sqlite3_file *file=bt ? sqlite3PagerFile(sqlite3BtreePager(bt)) : 0;
    OmpSqliteState *s;
    if( !file || file->pMethods!=&ompSqliteMethods ) continue;
    if( context->count>=(int)ArraySize(context->states) ){
      /* An impossible attached-limit mismatch still closes/frees everything,
      ** but can never report successful acknowledgment. */
      context->result=SQLITE_TOOBIG;
      break;
    }
    s=((unixFile*)file)->ompState;
    sqlite3_mutex_enter(s->mutex);
    s->references++;
    context->states[context->count++]=s;
    sqlite3_mutex_leave(s->mutex);
  }
}
static int ompSqliteCloseResult(OmpSqliteCloseContext *context){
  int i;
  for(i=0; i<context->count; i++){
    OmpSqliteState *s=context->states[i];
    sqlite3_mutex_enter(s->mutex);
    if( context->result==SQLITE_OK ){
      if( s->closeError!=SQLITE_OK ) context->result=s->closeError;
      else if( s->mainFile!=0 ) context->result=SQLITE_IOERR_AUTH;
    }
    sqlite3_mutex_leave(s->mutex);
    ompSqliteRelease(s);
  }
  context->count=0;
  return context->result;
}
