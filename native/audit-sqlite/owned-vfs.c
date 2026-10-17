/* Compiled inside SQLite's own os_unix.c, never an interposed VFS/addon. */
static _Atomic(sqlite3_uint64) ompSqliteNextGeneration = 1;
static sqlite3_uint64 ompSqliteGeneration(void){
  sqlite3_uint64 n = atomic_fetch_add(&ompSqliteNextGeneration, 1);
  if( n==0 || n==UINT64_MAX ) abort(); /* Never reuse a lifetime. */
  return n;
}
static int ompSqliteFault(OmpSqliteState *s){
  if( s ){
    s->fault = 1;
    if( s->backupSource ){
      sqlite3_mutex_enter(s->backupSource->mutex);
      s->backupSource->fault=1;
      sqlite3_mutex_leave(s->backupSource->mutex);
    }
  }
  return SQLITE_IOERR_AUTH;
}
static void ompSqliteRelease(OmpSqliteState *s){
  int release;
  OmpSqliteState *parent;
  sqlite3_mutex_enter(s->mutex);
  release=--s->references==0;
  parent=s->backupSource;
  sqlite3_mutex_leave(s->mutex);
  if( release ){
    close(s->parentFd);
    sqlite3_mutex_free(s->mutex);
    sqlite3_free(s->parentPath);
    sqlite3_free(s);
    if( parent ) ompSqliteRelease(parent);
  }
}
static int ompSqliteStat(int fd, struct stat *st){
  return fd>=0 && fstat(fd, st)==0 && S_ISREG(st->st_mode)
      && st->st_uid==geteuid() && (st->st_mode & 07777)==0600
      && st->st_nlink==1;
}
static int ompSqliteSame(const struct stat *a, const struct stat *b){
  return a->st_dev==b->st_dev && a->st_ino==b->st_ino
      && a->st_uid==b->st_uid && a->st_mode==b->st_mode
      && a->st_nlink==b->st_nlink;
}
/* Directory descriptors are namespace checks, never substitutes for a DB fd.
** Every component is opened relative to the previous owned directory, nofollow.
** Root-owned sticky temporary ancestors are allowed; the immediate parent must
** be a private 0700 directory of the effective uid. */
static int ompSqliteParent(const char *path){
  char part[MAX_PATHNAME+1];
  const char *p;
  int fd, next;
  struct stat st;
  if( !path || path[0]!='/' ) return -1;
  fd = open("/", O_RDONLY|O_DIRECTORY|O_CLOEXEC|O_NOFOLLOW);
  if( fd<0 ) return -1;
  p = path+1;
  while( *p ){
    const char *end = strchr(p, '/');
    size_t n = end ? (size_t)(end-p) : strlen(p);
    if( n==0 || n>MAX_PATHNAME || (n==1 && p[0]=='.')
        || (n==2 && p[0]=='.' && p[1]=='.') ) goto fail;
    memcpy(part, p, n); part[n] = 0;
    next = openat(fd, part, O_RDONLY|O_DIRECTORY|O_CLOEXEC|O_NOFOLLOW);
    if( next<0 ) goto fail;
    close(fd); fd = next;
    if( fstat(fd, &st)!=0 || !S_ISDIR(st.st_mode)
        || (st.st_uid!=0 && st.st_uid!=geteuid())
        || ((st.st_mode & 0022)!=0
            && !(st.st_uid==0 && (st.st_mode & S_ISVTX)!=0)) ) goto fail;
    if( !end ) break;
    p = end+1;
  }
  if( fstat(fd, &st)!=0 || st.st_uid!=geteuid()
      || (st.st_mode & 07777)!=0700 ) goto fail;
  return fd;
fail:
  close(fd);
  return -1;
}
static int ompSqliteNamespace(OmpSqliteState *s){
  struct stat owned, current;
  int fd = ompSqliteParent(s->parentPath);
  int ok = fd>=0 && fstat(s->parentFd, &owned)==0
      && fstat(fd, &current)==0 && owned.st_dev==current.st_dev
      && owned.st_ino==current.st_ino;
  if( fd>=0 ) close(fd);
  return ok ? SQLITE_OK : ompSqliteFault(s);
}
static int ompSqliteFileCheck(unixFile *p){
  struct stat now, named;
  const char *leaf = p->zPath ? strrchr(p->zPath,'/') : 0;
  OmpSqliteState *s = p->ompState;
  if( !ompSqliteStat(p->h, &now) || !ompSqliteSame(&now, &p->ompStat) )
    return ompSqliteFault(s);
  /* fstatat is only a namespace association check. All proof values above
  ** come from fstat of the exact owned fd, never from a separately opened fd. */
  if( !leaf || fstatat(s->parentFd,leaf+1,&named,AT_SYMLINK_NOFOLLOW)!=0
      || !ompSqliteSame(&now,&named) ) return ompSqliteFault(s);
  if( p==s->mainFile && s->armed
      && ((sqlite3_uint64)now.st_dev!=s->expectedDevice
          || (sqlite3_uint64)now.st_ino!=s->expectedInode) )
    return ompSqliteFault(s);
  return SQLITE_OK;
}
/* Caller holds this connection's recursive lifetime mutex. The shm mutex is
** separately required because its node may be shared with another connection. */
static int ompSqliteCheck(unixFile *p){
  OmpSqliteState *s = p->ompState;
  int rc;
  if( !s || s->fault || !s->mainFile || p->ompDeleted )
    return ompSqliteFault(s);
  if( s->backupSource ){
    OmpSqliteState *parent=s->backupSource;
    sqlite3_mutex_enter(parent->mutex);
    rc=parent->mainFile && parent->armed && !parent->backupOutput
        ? ompSqliteCheck(parent->mainFile) : ompSqliteFault(parent);
    sqlite3_mutex_leave(parent->mutex);
    if( rc!=SQLITE_OK ) return ompSqliteFault(s);
  }
  rc = ompSqliteNamespace(s);
  if( rc==SQLITE_OK ) rc = ompSqliteFileCheck(s->mainFile);
  if( rc==SQLITE_OK && s->walFile ) rc = ompSqliteFileCheck(s->walFile);
  if( rc==SQLITE_OK && s->journalFile ) rc = ompSqliteFileCheck(s->journalFile);
  if( rc==SQLITE_OK && s->mainFile->pShm ){
    unixShmNode *node = s->mainFile->pShm->pShmNode;
    sqlite3_mutex_enter(node->pShmMutex);
    rc = ompSqliteShmCheck(s->mainFile, node);
    sqlite3_mutex_leave(node->pShmMutex);
  }
  return rc;
}
/* Also used before the very first shm lock/truncate/map, including lazy open.
** Before publication the unix VFS global mutex owns the node; afterwards the
** node mutex and the connection's reference own it. No pathname fd is opened. */
static int ompSqliteShmCheck(unixFile *p, unixShmNode *node){
  OmpSqliteState *s = p->ompState;
  struct stat now, named;
  const char *leaf = node->zFilename ? strrchr(node->zFilename,'/') : 0;
  if( !s || s->fault || !s->armed || !s->mainFile || node->pInode!=p->pInode
      || node->hShm<0 || !ompSqliteStat(node->hShm, &now) )
    return ompSqliteFault(s);
  if( !leaf || fstatat(s->parentFd,leaf+1,&named,AT_SYMLINK_NOFOLLOW)!=0
      || !ompSqliteSame(&now,&named) ) return ompSqliteFault(s);
  if( node->ompGeneration==0 ){
    node->ompGeneration = ompSqliteGeneration();
    node->ompStat = now;
  }
  if( !ompSqliteSame(&now, &node->ompStat) ) return ompSqliteFault(s);
  if( s->shmNode!=node || s->shmGeneration!=node->ompGeneration ){
    /* A previously used mapping may only be replaced after xShmUnmap cleared
    ** this connection's reference. Reuse of an address is not identity. */
    if( s->shmNode!=0 ) return ompSqliteFault(s);
    if( s->shmSeen && s->transactionState
        && s->shmTransactionGeneration==s->transactionGeneration
        && !ompSqliteSame(&now,&s->previousShmStat) ) return ompSqliteFault(s);
    s->shmSeen=1;
    s->shmTransactionGeneration=s->transactionGeneration;
    s->previousShmStat=now;
    s->shmNode = node;
    s->shmGeneration = node->ompGeneration;
    s->shmStat = now;
  }
  return ompSqliteNamespace(s);
}
static int ompSqliteWriteCheck(unixFile *p){
  OmpSqliteState *s = p->ompState;
  int rc = ompSqliteCheck(p);
  if( rc==SQLITE_OK && (!s->armed || s->readonly) )
    rc = ompSqliteFault(s);
  return rc;
}
static void ompSqliteU64(u32 *p, sqlite3_uint64 value){
  p[0] = (u32)value; p[1] = (u32)(value>>32);
}
static void ompSqliteRecord(u32 *p, sqlite3_uint64 generation,
                            const struct stat *st){
  p[0] = 1;
  ompSqliteU64(p+1, generation);
  ompSqliteU64(p+3, (sqlite3_uint64)st->st_dev);
  ompSqliteU64(p+5, (sqlite3_uint64)st->st_ino);
  p[7] = (u32)st->st_uid; p[8] = (u32)st->st_mode;
  p[9] = (u32)st->st_nlink;
}
static int ompSqliteControl(unixFile *p, void *argument){
  u32 *out = (u32*)argument;
  u32 cmd;
  sqlite3_uint64 dev, ino;
  OmpSqliteState *s = p->ompState;
  int rc;
  if( !out || ((uintptr_t)out & 3)!=0 ) return SQLITE_MISUSE;
  if( out[0]!=OMP_SQLITE_MAGIC || out[1]!=1 || out[2]!=OMP_SQLITE_BYTES )
    return SQLITE_MISUSE;
  cmd = out[3];
  dev = (sqlite3_uint64)out[12] | ((sqlite3_uint64)out[13]<<32);
  ino = (sqlite3_uint64)out[14] | ((sqlite3_uint64)out[15]<<32);
  memset(out, 0, OMP_SQLITE_BYTES);
  out[0] = OMP_SQLITE_MAGIC; out[1] = 1; out[2] = OMP_SQLITE_BYTES;
  out[3] = cmd;
  if( !s || p!=s->mainFile ){
    out[4] = SQLITE_NOTFOUND; out[5] = 2; return SQLITE_NOTFOUND;
  }
  rc = ompSqliteCheck(p);
  if( cmd<1 || cmd>3 ) rc = SQLITE_MISUSE;
  if( rc==SQLITE_OK && cmd==2 ){
    if( s->backupOutput || dev!=(sqlite3_uint64)p->ompStat.st_dev
        || ino!=(sqlite3_uint64)p->ompStat.st_ino
        || (s->armed && (dev!=s->expectedDevice || ino!=s->expectedInode)) ){
      rc = ompSqliteFault(s);
    }else{
      s->expectedDevice = dev; s->expectedInode = ino; s->armed = 1;
    }
  }
  if( rc==SQLITE_OK && cmd==3 && (!s->armed || !s->readonly) )
    rc = ompSqliteFault(s);
  out[4] = (u32)rc; out[5] = rc==SQLITE_OK ? 1 : 2;
  ompSqliteU64(out+6, s->connectionGeneration);
  ompSqliteU64(out+8, s->transactionGeneration);
  out[10] = (u32)s->transactionState;
  if( rc==SQLITE_OK ){
    ompSqliteRecord(out+16, p->ompGeneration, &p->ompStat);
    if( s->walFile )
      ompSqliteRecord(out+32, s->walFile->ompGeneration, &s->walFile->ompStat);
    if( p->pShm )
      ompSqliteRecord(out+48, s->shmGeneration, &s->shmStat);
  }
  return rc;
}
static int ompSqliteClose(sqlite3_file *id){
  unixFile *p = (unixFile*)id;
  OmpSqliteState *s = p->ompState;
  const sqlite3_io_methods *base = p->ompMethods;
  int rc, invalid;
  sqlite3_mutex_enter(s->mutex);
  invalid = ompSqliteCheck(p->ompDeleted && s->mainFile ? s->mainFile : p);
  /* Cleanup must run even after a sticky fault. No successful proof survives. */
  if( p==s->mainFile ){
    s->mainFile = 0; s->fault = 1; s->shmNode = 0;
  }
  if( p==s->walFile ) s->walFile = 0;
  if( p==s->journalFile ) s->journalFile = 0;
  rc = base->xClose(id);
  /* sqlite3OsClose discards xClose's rc: preserve failure in live ownership
  ** state (and a retained backup source) before releasing any references. */
  if( rc!=SQLITE_OK ) (void)ompSqliteFault(s);
  sqlite3_mutex_leave(s->mutex);
  ompSqliteRelease(s);
  return invalid==SQLITE_OK ? rc : invalid;
}
#define OMP_CALL(P, CHECK, CALL) \
  OmpSqliteState *s = (P)->ompState; int rc; \
  sqlite3_mutex_enter(s->mutex); rc = CHECK(P); \
  if( rc==SQLITE_OK ) rc = (CALL); \
  if( rc!=SQLITE_OK && rc!=SQLITE_IOERR_SHORT_READ && s->backupSource ) \
    (void)ompSqliteFault(s); \
  sqlite3_mutex_leave(s->mutex); return rc
static int ompSqliteRead(sqlite3_file *id, void *buf, int n, i64 off){
  unixFile *p=(unixFile*)id;
  OMP_CALL(p, ompSqliteCheck, p->ompMethods->xRead(id,buf,n,off));
}
static int ompSqliteWrite(sqlite3_file *id, const void *buf, int n, i64 off){
  unixFile *p=(unixFile*)id;
  OMP_CALL(p, ompSqliteWriteCheck, p->ompMethods->xWrite(id,buf,n,off));
}
static int ompSqliteTruncate(sqlite3_file *id, i64 n){
  unixFile *p=(unixFile*)id;
  OMP_CALL(p, ompSqliteWriteCheck, p->ompMethods->xTruncate(id,n));
}
static int ompSqliteSync(sqlite3_file *id, int flags){
  unixFile *p=(unixFile*)id;
  OMP_CALL(p, ompSqliteCheck, p->ompMethods->xSync(id,flags));
}
static int ompSqliteSize(sqlite3_file *id, i64 *size){
  unixFile *p=(unixFile*)id;
  OMP_CALL(p, ompSqliteCheck, p->ompMethods->xFileSize(id,size));
}
static int ompSqliteLock(sqlite3_file *id, int level){
  unixFile *p=(unixFile*)id;
  OMP_CALL(p, ompSqliteCheck, p->ompMethods->xLock(id,level));
}
static int ompSqliteUnlock(sqlite3_file *id, int level){
  unixFile *p=(unixFile*)id; OmpSqliteState *s=p->ompState;
  int invalid, rc;
  sqlite3_mutex_enter(s->mutex); invalid=ompSqliteCheck(p);
  rc=p->ompMethods->xUnlock(id,level);
  sqlite3_mutex_leave(s->mutex);
  return invalid==SQLITE_OK ? rc : invalid;
}
static int ompSqliteReserved(sqlite3_file *id, int *reserved){
  unixFile *p=(unixFile*)id;
  OMP_CALL(p, ompSqliteCheck, p->ompMethods->xCheckReservedLock(id,reserved));
}
static int ompSqliteFileControl(sqlite3_file *id, int op, void *arg){
  unixFile *p=(unixFile*)id; OmpSqliteState *s=p->ompState; int rc;
  sqlite3_mutex_enter(s->mutex);
  if( op==OMP_SQLITE_CONTROL ){
    rc=ompSqliteControl(p,arg);
  }else if( op==OMP_SQLITE_TX_CONTROL ){
    int next=*(int*)arg;
    rc=ompSqliteCheck(p);
    if( rc==SQLITE_OK ){
      if( next && !s->transactionState )
        s->transactionGeneration=ompSqliteGeneration();
      s->transactionState=next;
    }
  }else if( op==OMP_SQLITE_DELETE_CONTROL ){
    const char *leaf=p->zPath ? strrchr(p->zPath,'/') : 0;
    rc=ompSqliteWriteCheck(p);
    if( rc==SQLITE_OK && (!leaf || (p!=s->walFile && p!=s->journalFile)) )
      rc=ompSqliteFault(s);
    if( rc==SQLITE_OK && unlinkat(s->parentFd,leaf+1,0)!=0 )
      rc=SQLITE_IOERR_DELETE;
    if( rc==SQLITE_OK ){
      /* The exact owned file has been unlinked while still live. It is no
      ** longer a present proof and only cleanup may use this unixFile. */
      p->ompDeleted=1;
      if( p==s->walFile ) s->walFile=0;
      if( p==s->journalFile ) s->journalFile=0;
      if( arg && *(int*)arg && full_fsync(s->parentFd,0,0)!=0 )
        rc=SQLITE_IOERR_DIR_FSYNC;
    }
  }else if( op==SQLITE_FCNTL_NULL_IO || op==SQLITE_FCNTL_FILE_POINTER
          || op==SQLITE_FCNTL_JOURNAL_POINTER || op==SQLITE_FCNTL_VFS_POINTER ){
    rc=SQLITE_NOTFOUND;
  }else{
    rc=(op==SQLITE_FCNTL_SIZE_HINT) ? ompSqliteWriteCheck(p) : ompSqliteCheck(p);
    if( rc==SQLITE_OK ) rc=p->ompMethods->xFileControl(id,op,arg);
  }
  sqlite3_mutex_leave(s->mutex); return rc;
}
static int ompSqliteSector(sqlite3_file *id){
  unixFile *p=(unixFile*)id; OmpSqliteState *s=p->ompState; int value;
  sqlite3_mutex_enter(s->mutex);
  value=ompSqliteCheck(p)==SQLITE_OK ? p->ompMethods->xSectorSize(id) : 0;
  sqlite3_mutex_leave(s->mutex); return value;
}
static int ompSqliteCapabilities(sqlite3_file *id){
  unixFile *p=(unixFile*)id; OmpSqliteState *s=p->ompState; int value;
  sqlite3_mutex_enter(s->mutex);
  value=ompSqliteCheck(p)==SQLITE_OK ? p->ompMethods->xDeviceCharacteristics(id) : 0;
  sqlite3_mutex_leave(s->mutex); return value;
}
static int ompSqliteShmMap(sqlite3_file *id,int region,int size,int extend,void volatile **out){
  unixFile *p=(unixFile*)id; *out=0;
  OMP_CALL(p, ompSqliteCheck, p->ompMethods->xShmMap(id,region,size,extend,out));
}
static int ompSqliteShmLock(sqlite3_file *id,int offset,int n,int flags){
  unixFile *p=(unixFile*)id; OmpSqliteState *s=p->ompState; int invalid,rc;
  sqlite3_mutex_enter(s->mutex); invalid=ompSqliteCheck(p);
  rc=(invalid==SQLITE_OK || (flags&SQLITE_SHM_UNLOCK))
      ? p->ompMethods->xShmLock(id,offset,n,flags) : invalid;
  sqlite3_mutex_leave(s->mutex); return invalid==SQLITE_OK ? rc : invalid;
}
static void ompSqliteShmBarrier(sqlite3_file *id){
  unixFile *p=(unixFile*)id; OmpSqliteState *s=p->ompState;
  sqlite3_mutex_enter(s->mutex);
  (void)ompSqliteCheck(p); /* void callback: latch fault for next I/O/control. */
  p->ompMethods->xShmBarrier(id);
  sqlite3_mutex_leave(s->mutex);
}
static int ompSqliteShmUnmap(sqlite3_file *id,int remove){
  unixFile *p=(unixFile*)id; OmpSqliteState *s=p->ompState; int invalid,rc;
  sqlite3_mutex_enter(s->mutex); invalid=ompSqliteCheck(p);
  rc=p->ompMethods->xShmUnmap(id,invalid==SQLITE_OK && !s->readonly ? remove : 0);
  s->shmNode=0; s->shmGeneration=0; memset(&s->shmStat,0,sizeof(s->shmStat));
  sqlite3_mutex_leave(s->mutex); return invalid==SQLITE_OK ? rc : invalid;
}
static int ompSqliteFetch(sqlite3_file *id,i64 offset,int n,void **out){
  unixFile *p=(unixFile*)id; *out=0;
  OMP_CALL(p, ompSqliteCheck, p->ompMethods->xFetch(id,offset,n,out));
}
static int ompSqliteUnfetch(sqlite3_file *id,i64 offset,void *data){
  unixFile *p=(unixFile*)id;
  OMP_CALL(p, ompSqliteCheck, p->ompMethods->xUnfetch(id,offset,data));
}
#undef OMP_CALL
static const sqlite3_io_methods ompSqliteMethods = {
  3, ompSqliteClose, ompSqliteRead, ompSqliteWrite, ompSqliteTruncate,
  ompSqliteSync, ompSqliteSize, ompSqliteLock, ompSqliteUnlock,
  ompSqliteReserved, ompSqliteFileControl, ompSqliteSector, ompSqliteCapabilities,
  ompSqliteShmMap, ompSqliteShmLock, ompSqliteShmBarrier, ompSqliteShmUnmap,
  ompSqliteFetch, ompSqliteUnfetch
};
static int ompSqliteAttach(unixFile *p, const char *path, int flags){
  OmpSqliteState *s;
  int type=flags&0x0fff00, rc=SQLITE_OK;
  struct stat st;
  if( !ompSqliteStat(p->h,&st) ) return SQLITE_CANTOPEN;
  if( type==SQLITE_OPEN_MAIN_DB ){
    const char *slash;
    size_t n;
    if( !path || path[0]!='/' || sqlite3_uri_boolean(path,"immutable",0)
        || sqlite3_uri_boolean(path,"nolock",0) ) return SQLITE_CANTOPEN;
    slash=strrchr(path,'/'); n=(size_t)(slash-path);
    s=sqlite3_malloc64(sizeof(*s));
    if( !s ) return SQLITE_NOMEM;
    memset(s,0,sizeof(*s)); s->parentFd=-1;
    s->parentPath=sqlite3_malloc64(n+1);
    s->mutex=sqlite3_mutex_alloc(SQLITE_MUTEX_RECURSIVE);
    if( !s->parentPath || !s->mutex ){
      sqlite3_free(s->parentPath); sqlite3_mutex_free(s->mutex); sqlite3_free(s);
      return SQLITE_NOMEM;
    }
    memcpy(s->parentPath,path,n); s->parentPath[n]=0;
    s->parentFd=ompSqliteParent(s->parentPath);
    if( s->parentFd<0 ){
      sqlite3_free(s->parentPath); sqlite3_mutex_free(s->mutex); sqlite3_free(s);
      return SQLITE_CANTOPEN;
    }
    s->mainFile=p; s->readonly=(flags&SQLITE_OPEN_READONLY)!=0;
    s->connectionGeneration=ompSqliteGeneration();
  }else if( type==SQLITE_OPEN_WAL || type==SQLITE_OPEN_MAIN_JOURNAL ){
    unixFile *main=(unixFile*)sqlite3_database_file_object(path);
    if( !main || main->pMethod!=&ompSqliteMethods || !main->ompState )
      return SQLITE_CANTOPEN;
    s=main->ompState;
  }else{
    /* All temporary work is forced into memory by compile options. Attached
    ** super-journals and unassociated persistent files are not managed. */
    return SQLITE_CANTOPEN;
  }
  sqlite3_mutex_enter(s->mutex);
  p->ompState=s; p->ompMethods=p->pMethod; p->ompStat=st;
  p->ompGeneration=ompSqliteGeneration(); p->ompOpenFlags=flags;
  s->references++;
  if( type==SQLITE_OPEN_WAL ){
    if( s->walFile || (s->walSeen && s->transactionState
        && s->walTransactionGeneration==s->transactionGeneration
        && !ompSqliteSame(&st,&s->previousWalStat)) ){
      rc=ompSqliteFault(s);
    }else{
      s->walFile=p; s->walSeen=1; s->previousWalStat=st;
      s->walTransactionGeneration=s->transactionGeneration;
    }
  }else if( type==SQLITE_OPEN_MAIN_JOURNAL ){
    if( s->journalFile ) rc=ompSqliteFault(s); else s->journalFile=p;
  }
  p->pMethod=&ompSqliteMethods;
  if( rc==SQLITE_OK ) rc=ompSqliteCheck(p);
  if( rc==SQLITE_OK && type!=SQLITE_OPEN_MAIN_DB && !s->armed )
    rc=ompSqliteFault(s);
  sqlite3_mutex_leave(s->mutex);
  return rc;
}
/* These functions are called only by the patched VACUUM core. They are not
** exported symbols or file-control commands and accept no JS destination DTO. */
static int ompSqliteVacuumSourceCheck(sqlite3_file *id, int result){
  unixFile *p;
  OmpSqliteState *s;
  int rc;
  if( !id || id->pMethods!=&ompSqliteMethods ) return SQLITE_IOERR_AUTH;
  p=(unixFile*)id; s=p->ompState;
  sqlite3_mutex_enter(s->mutex);
  rc=ompSqliteCheck(p);
  if( result!=SQLITE_OK || !s->armed || s->backupOutput )
    rc=ompSqliteFault(s);
  sqlite3_mutex_leave(s->mutex);
  return rc;
}
static int ompSqliteVacuumBind(sqlite3_file *source, sqlite3_file *destination){
  unixFile *from, *to;
  OmpSqliteState *parent, *child;
  struct stat actual;
  int rc;
  int creation=SQLITE_OPEN_CREATE|SQLITE_OPEN_EXCLUSIVE|SQLITE_OPEN_READWRITE;
  if( !source || !destination || source->pMethods!=&ompSqliteMethods
      || destination->pMethods!=&ompSqliteMethods || source==destination )
    return SQLITE_IOERR_AUTH;
  from=(unixFile*)source; to=(unixFile*)destination;
  parent=from->ompState; child=to->ompState;
  if( parent==child ) return SQLITE_IOERR_AUTH;
  /* Every backup callback uses child -> parent order, never parent -> child. */
  sqlite3_mutex_enter(child->mutex);
  sqlite3_mutex_enter(parent->mutex);
  rc=ompSqliteCheck(from);
  if( rc==SQLITE_OK ) rc=ompSqliteCheck(to);
  if( rc==SQLITE_OK && (!parent->armed || parent->backupOutput
      || child->armed || child->backupOutput || child->backupSource
      || child->readonly || to!=child->mainFile
      || child->walFile || child->journalFile || to->pShm
      || (to->ompOpenFlags&creation)!=creation
      || !ompSqliteStat(to->h,&actual) || actual.st_size!=0) )
    rc=ompSqliteFault(parent);
  if( rc==SQLITE_OK ){
    child->expectedDevice=(sqlite3_uint64)actual.st_dev;
    child->expectedInode=(sqlite3_uint64)actual.st_ino;
    child->backupOutput=1;
    child->backupSource=parent;
    child->armed=1;
    parent->references++; /* Retain source state through output's final close. */
  }else{
    (void)ompSqliteFault(parent);
    (void)ompSqliteFault(child);
  }
  sqlite3_mutex_leave(parent->mutex);
  sqlite3_mutex_leave(child->mutex);
  return rc;
}
static int ompSqliteVacuumFinish(sqlite3_file *source, sqlite3_file *destination,
                                int result){
  unixFile *to;
  OmpSqliteState *s;
  int rc;
  if( !destination || destination->pMethods!=&ompSqliteMethods )
    return ompSqliteVacuumSourceCheck(source,SQLITE_IOERR_AUTH);
  to=(unixFile*)destination; s=to->ompState;
  sqlite3_mutex_enter(s->mutex);
  rc=ompSqliteCheck(to);
  if( result!=SQLITE_OK || !s->backupOutput || !s->backupSource )
    rc=ompSqliteFault(s);
  sqlite3_mutex_leave(s->mutex);
  if( rc!=SQLITE_OK ) return ompSqliteVacuumSourceCheck(source,rc);
  return ompSqliteVacuumSourceCheck(source,SQLITE_OK);
}
