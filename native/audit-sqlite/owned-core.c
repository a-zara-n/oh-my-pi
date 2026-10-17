/* Included immediately before the sqlite3_file_control definition. */
static int ompSqliteReadonlyAuthorizer(void *unused, int action,
  const char *a, const char *b, const char *database, const char *trigger
){
  static const char *const functions[] = {
    "abs","avg","char","coalesce","concat","concat_ws","count","glob",
    "hex","ifnull","iif","instr","length","like","lower","ltrim",
    "max","min","nullif","octet_length","printf","quote","replace",
    "round","rtrim","sign","sqlite_source_id","sqlite_version","substr",
    "substring","sum","total","trim","typeof","unicode","unhex","upper"
  };
  unsigned i;
  UNUSED_PARAMETER(unused); UNUSED_PARAMETER(database); UNUSED_PARAMETER(trigger);
  switch( action ){
    case SQLITE_SELECT:
    case SQLITE_READ:
    case SQLITE_RECURSIVE:
      return SQLITE_OK;
    case SQLITE_TRANSACTION:
      return a && (sqlite3_stricmp(a,"BEGIN")==0
          || sqlite3_stricmp(a,"COMMIT")==0 || sqlite3_stricmp(a,"ROLLBACK")==0)
          ? SQLITE_OK : SQLITE_DENY;
    case SQLITE_FUNCTION:
      for(i=0; b && i<ArraySize(functions); i++){
        if( sqlite3_stricmp(b,functions[i])==0 ) return SQLITE_OK;
      }
      return SQLITE_DENY;
    case SQLITE_PRAGMA:
      if( !a ) return SQLITE_DENY;
      if( sqlite3_stricmp(a,"trusted_schema")==0 )
        return !b || sqlite3_stricmp(b,"OFF")==0 || strcmp(b,"0")==0
            ? SQLITE_OK : SQLITE_DENY;
      if( sqlite3_stricmp(a,"query_only")==0
          || sqlite3_stricmp(a,"foreign_keys")==0
          || sqlite3_stricmp(a,"recursive_triggers")==0 )
        return !b || sqlite3_stricmp(b,"ON")==0 || strcmp(b,"1")==0
            ? SQLITE_OK : SQLITE_DENY;
      if( sqlite3_stricmp(a,"table_info")==0
          || sqlite3_stricmp(a,"table_xinfo")==0
          || sqlite3_stricmp(a,"table_list")==0
          || sqlite3_stricmp(a,"foreign_key_check")==0
          || sqlite3_stricmp(a,"quick_check")==0
          || sqlite3_stricmp(a,"integrity_check")==0
          || sqlite3_stricmp(a,"index_list")==0
          || sqlite3_stricmp(a,"index_info")==0
          || sqlite3_stricmp(a,"index_xinfo")==0
          || sqlite3_stricmp(a,"foreign_key_list")==0 ) return SQLITE_OK;
      if( b==0 && (sqlite3_stricmp(a,"application_id")==0
          || sqlite3_stricmp(a,"user_version")==0
          || sqlite3_stricmp(a,"schema_version")==0
          || sqlite3_stricmp(a,"journal_mode")==0
          || sqlite3_stricmp(a,"compile_options")==0) ) return SQLITE_OK;
      return SQLITE_DENY;
    default:
      return SQLITE_DENY;
  }
}
static int ompSqliteCoreControl(sqlite3 *db, Btree *bt, sqlite3_file *fd, void *arg){
  u32 *out=(u32*)arg;
  int command, rc;
  if( !out || ((uintptr_t)out&3)!=0 || out[0]!=OMP_SQLITE_MAGIC
      || out[1]!=1 || out[2]!=OMP_SQLITE_BYTES ) return SQLITE_MISUSE;
  command=(int)out[3];
  rc=sqlite3OsFileControl(fd,OMP_SQLITE_CONTROL,arg);
  if( rc!=SQLITE_OK ) return rc;
  if( command==3 ){
    if( sqlite3_db_readonly(db,"main")!=1 ) rc=SQLITE_READONLY;
    if( rc==SQLITE_OK ) rc=sqlite3_db_config(db,SQLITE_DBCONFIG_TRUSTED_SCHEMA,0,0);
    if( rc==SQLITE_OK ){
      db->flags |= SQLITE_QueryOnly;
      rc=sqlite3_set_authorizer(db,ompSqliteReadonlyAuthorizer,0);
    }
  }
  out[10]=(u32)sqlite3_txn_state(db,"main");
  if( sqlite3PagerGetJournalMode(sqlite3BtreePager(bt))!=PAGER_JOURNALMODE_WAL ){
    if( out[32]==0 ) out[32]=2;
    if( out[48]==0 ) out[48]=2;
  }
  out[4]=(u32)rc; out[5]=rc==SQLITE_OK ? 1 : 2;
  return rc;
}
