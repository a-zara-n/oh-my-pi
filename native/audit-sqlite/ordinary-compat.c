/* Parent-run real-library regression fixture; no callback/filesystem mocks.
** Link only to the new pinned dylib (README). Retain fixtures for inspection. */
#include "sqlite3.h"
#include <errno.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <unistd.h>

#define OWNED_VFS "omp-owned-v1"
#define CONTROL 0x4f4d5001
#define AUTH_IOERR (SQLITE_IOERR | (28<<8))
static char root[]="/private/tmp/omp-sqlite-ordinary-compat-XXXXXX";
static const char *phase="setup";
static void require(int ok, const char *message){
  if( !ok ){
    fprintf(stderr,"FAIL %s: %s (fixtures: %s)\n",phase,message,root);
    exit(1);
  }
}
static void filename(char *out, size_t size, const char *leaf){
  int n=snprintf(out,size,"%s/%s",root,leaf);
  require(n>0 && (size_t)n<size,"format path");
}
static sqlite3 *openVfs(const char *name, int flags, const char *vfs){
  sqlite3 *db=0;
  require(sqlite3_open_v2(name,&db,flags,vfs)==SQLITE_OK,"open database");
  sqlite3_extended_result_codes(db,1);
  return db;
}
static sqlite3 *openDb(const char *name, int flags){
  return openVfs(name,flags,0);
}
static sqlite3 *openOwned(const char *name, int flags){
  /* Standard SQLite's existing zVfs argument selects intent before xOpen. */
  return openVfs(name,flags,OWNED_VFS);
}
static int execute(sqlite3 *db, const char *text){
  return sqlite3_exec(db,text,0,0,0);
}
static void sql(sqlite3 *db, const char *text){
  int rc=execute(db,text);
  if( rc!=SQLITE_OK ) fprintf(stderr,"SQL rc=%d: %s\n",rc,sqlite3_errmsg(db));
  require(rc==SQLITE_OK,text);
}
static void sqlPath(sqlite3 *db, const char *format, const char *path){
  char *text=sqlite3_mprintf(format,path);
  require(text!=0,"allocate SQL"); sql(db,text); sqlite3_free(text);
}
static int rejectPath(sqlite3 *db, const char *format, const char *path){
  char *text=sqlite3_mprintf(format,path);
  int rc;
  require(text!=0,"allocate refusal SQL"); rc=execute(db,text); sqlite3_free(text);
  return rc;
}
static int scalar(sqlite3 *db, const char *text){
  sqlite3_stmt *statement=0;
  int value;
  require(sqlite3_prepare_v2(db,text,-1,&statement,0)==SQLITE_OK,"prepare scalar");
  require(sqlite3_step(statement)==SQLITE_ROW,"step scalar");
  value=sqlite3_column_int(statement,0);
  require(sqlite3_finalize(statement)==SQLITE_OK,"finalize scalar");
  return value;
}
static int control(sqlite3 *db, uint32_t *words, int command, const uint32_t *identity){
  memset(words,0,64*sizeof(*words));
  words[0]=0x4f4d5053; words[1]=1; words[2]=256; words[3]=(uint32_t)command;
  if( identity ) memcpy(words+12,identity,4*sizeof(*words));
  return sqlite3_file_control(db,"main",CONTROL,words);
}
static void arm(sqlite3 *db){
  uint32_t words[64], identity[4];
  require(control(db,words,1,0)==SQLITE_OK,"inspect already-owned main");
  require(words[5]==1 && words[16]==1 && (words[6] || words[7]),"live main record");
  memcpy(identity,words+19,sizeof(identity));
  require(control(db,words,2,identity)==SQLITE_OK,"arm actual owned main");
}
static void closeOk(sqlite3 *db){
  require(sqlite3_close(db)==SQLITE_OK,"close database");
}
static void closeFault(sqlite3 *db){
  /* Owned close frees db even on failure: never dereference it again. */
  require(sqlite3_close(db)!=SQLITE_OK,"propagate owned close failure");
}
static void ordinary(void){
  char publicDir[1024], alias[1024], name[1024], attached[1024], copy[1024], uri[1200];
  sqlite3 *db, *reader;
  uint32_t words[64], wrong[4]={0,0,0,0};
  FILE *empty;
  phase="ordinary modes, DDL, metadata, tx, attach, temp, vacuum";
  filename(publicDir,sizeof(publicDir),"public"); filename(alias,sizeof(alias),"alias");
  require(mkdir(publicDir,0755)==0 && chmod(publicDir,0755)==0,"ordinary 0755 parent");
  require(symlink(publicDir,alias)==0,"ordinary symlink parent");
  filename(name,sizeof(name),"alias/ordinary.db");
  filename(attached,sizeof(attached),"public/attached.db"); filename(copy,sizeof(copy),"public/copy.db");
  db=openDb(name,SQLITE_OPEN_READWRITE|SQLITE_OPEN_CREATE);
  require(control(db,words,1,0)==SQLITE_NOTFOUND,"ordinary inspect never enrolls");
  require(control(db,words,2,wrong)==SQLITE_NOTFOUND,"ordinary arm never enrolls");
  require(control(db,words,3,0)==SQLITE_NOTFOUND,"ordinary policy command never enrolls");
  require(chmod(name,0644)==0,"ordinary post-open chmod");
  sql(db,"CREATE TABLE t(id INTEGER PRIMARY KEY,value TEXT);CREATE INDEX t_value ON t(value)");
  require(scalar(db,"SELECT count(*) FROM sqlite_master WHERE name IN ('t','t_value')")==2,"first DDL/index/master");
  sql(db,"BEGIN IMMEDIATE;INSERT INTO t VALUES(1,'rollback');ROLLBACK;BEGIN;INSERT INTO t VALUES(1,'committed');COMMIT");
  require(scalar(db,"SELECT count(*) FROM t")==1,"ordinary transaction");
  sqlPath(db,"ATTACH %Q AS other",attached);
  sql(db,"CREATE TABLE other.t(value);BEGIN IMMEDIATE;INSERT INTO main.t VALUES(2,'attached');INSERT INTO other.t VALUES(7);COMMIT");
  require(scalar(db,"SELECT sum(value) FROM other.t")==7,"multi-database transaction/super-journal");
  sql(db,"DETACH other;CREATE TEMP TABLE scratch(value);INSERT INTO scratch VALUES(3)");
  require(scalar(db,"SELECT value FROM scratch")==3,"ordinary temporary database");
  sql(db,"VACUUM");
  empty=fopen(copy,"wb"); require(empty!=0,"preexisting empty ordinary output");
  require(fclose(empty)==0,"close empty output"); sqlPath(db,"VACUUM INTO %Q",copy); closeOk(db);
  reader=openDb(copy,SQLITE_OPEN_READONLY);
  require(scalar(reader,"SELECT count(*) FROM t")==2,"ordinary vacuum copy"); closeOk(reader);
  snprintf(uri,sizeof(uri),"file:%s?mode=ro&immutable=1",name);
  reader=openDb(uri,SQLITE_OPEN_READONLY|SQLITE_OPEN_URI);
  require(scalar(reader,"SELECT count(*) FROM t")==2,"ordinary immutable URI"); closeOk(reader);
  snprintf(uri,sizeof(uri),"file:%s?nolock=1",name);
  db=openDb(uri,SQLITE_OPEN_READWRITE|SQLITE_OPEN_URI);
  sql(db,"INSERT INTO t VALUES(3,'nolock')"); closeOk(db);
}
static void namedStartup(void){
  char name[1024], uri[1200];
  sqlite3 *db=0;
  uint32_t words[64];
  int rc;
  phase="named startup parent/mode refusal precedes command 1";
  filename(name,sizeof(name),"public/refused-before-create.db");
  rc=sqlite3_open_v2(name,&db,SQLITE_OPEN_READWRITE|SQLITE_OPEN_CREATE,OWNED_VFS);
  require((rc&255)==SQLITE_CANTOPEN,"named public-parent open rejected");
  if( db ) closeOk(db);
  require(access(name,F_OK)!=0 && errno==ENOENT,"named bad-parent file never created");
  filename(name,sizeof(name),"private/bad-mode.db");
  db=openDb(name,SQLITE_OPEN_READWRITE|SQLITE_OPEN_CREATE); closeOk(db);
  require(chmod(name,0644)==0,"seed non-owned permissions"); db=0;
  rc=sqlite3_open_v2(name,&db,SQLITE_OPEN_READONLY,OWNED_VFS);
  require((rc&255)==SQLITE_CANTOPEN,"named mode refused during open, not late inspect");
  if( db ) closeOk(db);
  phase="standard URI selects named VFS before main header I/O";
  filename(name,sizeof(name),"private/uri #?.db");
  snprintf(uri,sizeof(uri),"file:%s/private/uri%%20%%23%%3F.db?vfs=" OWNED_VFS,root);
  db=openDb(uri,SQLITE_OPEN_READWRITE|SQLITE_OPEN_CREATE|SQLITE_OPEN_URI);
  require(strcmp(sqlite3_db_filename(db,"main"),name)==0,"canonical decoded native filename");
  arm(db); sql(db,"CREATE TABLE t(value);INSERT INTO t VALUES(1)"); closeOk(db);
  phase="ordinary SQL cannot be enrolled late, including existing WAL handles";
  filename(name,sizeof(name),"private/late-ordinary.db");
  db=openDb(name,SQLITE_OPEN_READWRITE|SQLITE_OPEN_CREATE);
  sql(db,"PRAGMA journal_mode=WAL;CREATE TABLE t(value);BEGIN IMMEDIATE;INSERT INTO t VALUES(1)");
  require(control(db,words,1,0)==SQLITE_NOTFOUND,"active ordinary inspect rejected");
  sql(db,"ROLLBACK;INSERT INTO t VALUES(2)");
  require(control(db,words,1,0)==SQLITE_NOTFOUND,"cached WAL ordinary inspect rejected");
  require(scalar(db,"SELECT value FROM t")==2,"failed promotion leaves ordinary usable"); closeOk(db);
}
static void mixed(int ownedFirst){
  char name[1024], leaf[80];
  sqlite3 *first, *second, *reader;
  uint32_t words[64];
  snprintf(leaf,sizeof(leaf),"private/mixed-%d.db",ownedFirst); filename(name,sizeof(name),leaf);
  phase=ownedFirst ? "owned-first mixed WAL/shared node/RO/close" : "ordinary-first mixed WAL/shared node/RO/close";
  first=ownedFirst ? openOwned(name,SQLITE_OPEN_READWRITE|SQLITE_OPEN_CREATE) : openDb(name,SQLITE_OPEN_READWRITE|SQLITE_OPEN_CREATE);
  if( ownedFirst ) arm(first);
  sql(first,"PRAGMA journal_mode=WAL;PRAGMA wal_autocheckpoint=0;CREATE TABLE t(value);INSERT INTO t VALUES(1)");
  second=ownedFirst ? openDb(name,SQLITE_OPEN_READWRITE) : openOwned(name,SQLITE_OPEN_READWRITE);
  if( !ownedFirst ) arm(second);
  sql(second,"BEGIN;SELECT * FROM t;COMMIT;BEGIN IMMEDIATE;INSERT INTO t VALUES(2);COMMIT");
  require(scalar(first,"SELECT count(*) FROM t")==2,"mixed committed rows");
  reader=openOwned(name,SQLITE_OPEN_READONLY); arm(reader);
  require(control(reader,words,3,0)==SQLITE_OK,"fixed readonly before first SELECT");
  require(sqlite3_db_readonly(reader,"main")==1,"actual readonly main");
  sql(reader,"BEGIN;SELECT * FROM t;COMMIT");
  require(control(reader,words,1,0)==SQLITE_OK && words[48]==1,"managed readonly shared node/readmarks");
  require(execute(reader,"PRAGMA query_only=OFF")==SQLITE_AUTH,"fixed policy refusal");
  require(control(reader,words,1,0)==SQLITE_OK,"policy refusal does not poison source"); closeOk(reader);
  closeOk(first); sql(second,"INSERT INTO t VALUES(3)"); closeOk(second);
  first=openDb(name,SQLITE_OPEN_READWRITE);
  require(scalar(first,"SELECT count(*) FROM t")==3,"ordinary reopen after managed close");
  sql(first,"PRAGMA wal_checkpoint(TRUNCATE)"); closeOk(first);
}
static void managedCopy(void){
  char name[1024], copy[1024];
  sqlite3 *db, *reader, *output;
  uint32_t words[64];
  phase="owned RW/RO vacuum outputs remain non-authoritative";
  filename(name,sizeof(name),"private/copy-source.db"); filename(copy,sizeof(copy),"private/copy-rw.db");
  db=openOwned(name,SQLITE_OPEN_READWRITE|SQLITE_OPEN_CREATE); arm(db);
  sql(db,"CREATE TABLE t(value);INSERT INTO t VALUES(11)"); sqlPath(db,"VACUUM INTO %Q",copy);
  require(control(db,words,1,0)==SQLITE_OK,"owned RW copy source remains live"); closeOk(db);
  reader=openOwned(name,SQLITE_OPEN_READONLY); arm(reader);
  filename(copy,sizeof(copy),"private/copy-ro.db"); sqlPath(reader,"VACUUM INTO %Q",copy);
  require(control(reader,words,1,0)==SQLITE_OK,"owned RO copy source remains live"); closeOk(reader);
  output=openDb(copy,SQLITE_OPEN_READONLY);
  require(scalar(output,"SELECT value FROM t")==11,"ordinary readonly copy consumer");
  require(control(output,words,1,0)==SQLITE_NOTFOUND,"copy query does not enroll ordinary consumer"); closeOk(output);
}
static void sticky(void){
  char name[1024], moved[1024];
  sqlite3 *db, *ordinaryPeer;
  uint32_t words[64], wrong[4]={0,0,0,0};
  phase="owned namespace rename/swap-back and close stay sticky";
  filename(name,sizeof(name),"private/sticky.db"); filename(moved,sizeof(moved),"private/sticky-moved.db");
  db=openOwned(name,SQLITE_OPEN_READWRITE|SQLITE_OPEN_CREATE); arm(db);
  sql(db,"CREATE TABLE t(value);INSERT INTO t VALUES(1)"); ordinaryPeer=openDb(name,SQLITE_OPEN_READWRITE);
  require(rename(name,moved)==0,"rename owned main");
  require(control(db,words,1,0)==AUTH_IOERR,"owned rename rejected");
  require(rename(moved,name)==0,"restore original pathname");
  require(control(db,words,1,0)==AUTH_IOERR,"no owned swap-back revival");
  sql(ordinaryPeer,"INSERT INTO t VALUES(2)"); closeOk(ordinaryPeer); closeFault(db);
  phase="owned expected identity mismatch cannot downgrade";
  db=openOwned(name,SQLITE_OPEN_READWRITE); arm(db);
  require(control(db,words,2,wrong)==AUTH_IOERR,"mismatched arm rejected");
  require(control(db,words,1,0)==AUTH_IOERR,"mismatched arm stays faulted"); closeFault(db);
  phase="pending named ownership cannot mutate or return to ordinary";
  db=openOwned(name,SQLITE_OPEN_READWRITE);
  require(control(db,words,1,0)==SQLITE_OK,"pending inspect");
  require((execute(db,"INSERT INTO t VALUES(3)")&255)==SQLITE_IOERR,"pending write rejected");
  require(control(db,words,1,0)==AUTH_IOERR,"pending write failure sticky"); closeFault(db);
  phase="owned metadata fault vs independent ordinary connection";
  db=openOwned(name,SQLITE_OPEN_READWRITE); arm(db); ordinaryPeer=openDb(name,SQLITE_OPEN_READWRITE);
  require(chmod(name,0644)==0,"change ordinary metadata");
  require(scalar(ordinaryPeer,"SELECT count(*) FROM t")==2,"ordinary read permits standard metadata");
  require(control(db,words,1,0)==AUTH_IOERR,"owned metadata change rejected");
  require(chmod(name,0600)==0,"restore metadata");
  require(control(db,words,1,0)==AUTH_IOERR,"metadata restoration cannot revive owned state");
  closeOk(ordinaryPeer); closeFault(db);
}
static void ownedAttachAndNamespace(void){
  char name[1024], attached[1024], parent[1024], moved[1024], escape[1024], uri[1200];
  sqlite3 *db;
  uint32_t words[64];
  phase="owned disk ATTACH/VACUUM cannot override to ordinary or foreign VFS";
  filename(name,sizeof(name),"private/attach-source.db"); filename(attached,sizeof(attached),"private/attach-child.db");
  filename(escape,sizeof(escape),"public/escape.db");
  db=openOwned(name,SQLITE_OPEN_READWRITE|SQLITE_OPEN_CREATE); arm(db);
  sql(db,"CREATE TABLE t(value);CREATE TEMP TABLE scratch(value);INSERT INTO scratch VALUES(5)");
  require(scalar(db,"SELECT value FROM scratch")==5,"owned memory scratch");
  snprintf(uri,sizeof(uri),"file:%s?vfs=unix",escape);
  require(rejectPath(db,"ATTACH %Q AS escaped",uri)!=SQLITE_OK,"ordinary disk VFS override refused");
  require(access(escape,F_OK)!=0 && errno==ENOENT,"ATTACH refusal precedes child file creation");
  require(rejectPath(db,"VACUUM INTO %Q",uri)!=SQLITE_OK,"ordinary output VFS override refused");
  require(access(escape,F_OK)!=0 && errno==ENOENT,"copy refusal precedes output creation");
  snprintf(uri,sizeof(uri),"file:%s?vfs=unix-none",escape);
  require(rejectPath(db,"ATTACH %Q AS escaped",uri)!=SQLITE_OK,"alternate-lock VFS override refused");
  require(control(db,words,1,0)==SQLITE_OK,"SQL VFS refusal keeps valid source healthy");
  sql(db,"ATTACH ':memory:' AS memory_child;CREATE TABLE memory_child.t(value);INSERT INTO memory_child.t VALUES(8)");
  require(scalar(db,"SELECT value FROM memory_child.t")==8,"owned memory ATTACH remains memory");
  sql(db,"DETACH memory_child");
  phase="owned implicit ATTACH inherits pending guards";
  sqlPath(db,"ATTACH %Q AS child",attached);
  require(scalar(db,"SELECT count(*) FROM child.sqlite_master")==0,"pending child read");
  require((execute(db,"CREATE TABLE child.forbidden(value)")&255)==SQLITE_IOERR,"no ordinary attached-write bypass"); closeFault(db);
  phase="owned parent-directory rename and restoration stay sticky";
  filename(name,sizeof(name),"private/namespace.db"); filename(parent,sizeof(parent),"private"); filename(moved,sizeof(moved),"private-moved");
  db=openOwned(name,SQLITE_OPEN_READWRITE|SQLITE_OPEN_CREATE); arm(db);
  require(rename(parent,moved)==0,"rename owned parent");
  require(control(db,words,1,0)==AUTH_IOERR,"owned parent namespace refusal");
  require(rename(moved,parent)==0,"restore owned parent");
  require(control(db,words,1,0)==AUTH_IOERR,"parent restoration cannot revive ownership"); closeFault(db);
}
static void crashCleanup(void){
  char name[1024], journal[1100];
  sqlite3 *db;
  pid_t child;
  int status;
  phase="ordinary rollback-journal crash recovery and cleanup";
  filename(name,sizeof(name),"public/crash.db");
  db=openDb(name,SQLITE_OPEN_READWRITE|SQLITE_OPEN_CREATE);
  sql(db,"PRAGMA journal_mode=DELETE;CREATE TABLE t(value);WITH RECURSIVE n(x) AS(VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<80) INSERT INTO t SELECT zeroblob(1000) FROM n"); closeOk(db);
  child=fork(); require(child>=0,"fork journal writer");
  if( child==0 ){
    db=openDb(name,SQLITE_OPEN_READWRITE);
    sql(db,"PRAGMA cache_size=1;PRAGMA cache_spill=ON;BEGIN IMMEDIATE;UPDATE t SET value=zeroblob(3000)");
    _exit(0); /* Deliberately skip SQLite close/rollback. */
  }
  require(waitpid(child,&status,0)==child && WIFEXITED(status) && WEXITSTATUS(status)==0,"crash writer completed");
  snprintf(journal,sizeof(journal),"%s-journal",name);
  require(access(journal,F_OK)==0,"real crash journal exists");
  db=openDb(name,SQLITE_OPEN_READWRITE);
  require(scalar(db,"SELECT sum(length(value)) FROM t")==80000,"ordinary hot-journal rollback"); closeOk(db);
  require(access(journal,F_OK)!=0,"ordinary recovered journal removed");
  phase="ordinary WAL crash recovery including readonly connection";
  child=fork(); require(child>=0,"fork WAL writer");
  if( child==0 ){
    db=openDb(name,SQLITE_OPEN_READWRITE);
    sql(db,"PRAGMA journal_mode=WAL;PRAGMA wal_autocheckpoint=0;INSERT INTO t VALUES(zeroblob(17))"); _exit(0);
  }
  require(waitpid(child,&status,0)==child && WIFEXITED(status) && WEXITSTATUS(status)==0,"WAL writer completed");
  db=openDb(name,SQLITE_OPEN_READONLY);
  require(scalar(db,"SELECT count(*) FROM t")==81,"ordinary RO WAL recovery"); closeOk(db);
  db=openDb(name,SQLITE_OPEN_READWRITE); sql(db,"PRAGMA wal_checkpoint(TRUNCATE)"); closeOk(db);
}
int main(void){
  char privateDir[1024];
  require(mkdtemp(root)!=0,"create fixture root"); filename(privateDir,sizeof(privateDir),"private");
  require(mkdir(privateDir,0700)==0,"create owned fixture directory");
  require(strcmp(sqlite3_sourceid(),"2026-10-16 14:45:20 555e07ef33f69a0957d24d8e555b702464a131d6f1607f4c3c1e4551e8e6ca76")==0,"link pinned source/checkin");
  require(strcmp(sqlite3_libversion(),"3.54.1")==0,"link pinned selected library");
  require(sqlite3_vfs_find(0)!=sqlite3_vfs_find(OWNED_VFS) && sqlite3_vfs_find(OWNED_VFS)!=0,"owned VFS exists and is not default");
  require(strcmp(sqlite3_vfs_find(0)->zName,"unix")==0,"ordinary unix remains default");
  ordinary(); namedStartup(); mixed(0); mixed(1); managedCopy(); sticky(); ownedAttachAndNamespace(); crashCleanup();
  printf("PASS real native ordinary/named-owned compatibility (fixtures retained: %s)\n",root);
  return 0;
}
