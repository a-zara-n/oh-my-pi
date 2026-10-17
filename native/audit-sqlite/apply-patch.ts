import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Exact preimages in the verified canonical amalgamation. No fuzzy patches. */
export function patchAmalgamation(canonical: string): string {
	let source = canonical;
	function replace(before: string, after: string): void {
		if (source.split(before).length !== 2) throw new Error(`SQLite patch preimage count rejected: ${before.slice(0, 90)}`);
		source = source.replace(before, after);
	}
	function fragment(name: string): string {
		return readFileSync(join(import.meta.dir, name), "utf8");
	}
	replace("typedef struct unixFile unixFile;\nstruct unixFile {", `${fragment("owned-types.h")}\ntypedef struct unixFile unixFile;\nstruct unixFile {`);
	replace("  int h;                              /* The file descriptor */", "  int h;                              /* The file descriptor */\n  OmpSqliteState *ompState;\n  const sqlite3_io_methods *ompMethods;\n  sqlite3_uint64 ompGeneration;\n  struct stat ompStat;\n  int ompOpenFlags;\n  int ompDeleted;");
	replace("struct unixShmNode {\n", "struct unixShmNode {\n  sqlite3_uint64 ompGeneration;\n  struct stat ompStat;\n");
	// The implementation is below all real callbacks, above the methods table.
	replace("#define IOMETHODS(FINDER,METHOD,VERSION,CLOSE,LOCK,UNLOCK,CKLOCK,SHMMAP)", `${fragment("owned-vfs.c")}\n#define IOMETHODS(FINDER,METHOD,VERSION,CLOSE,LOCK,UNLOCK,CKLOCK,SHMMAP)`);
	replace("static void robust_close(unixFile *pFile, int h, int lineno){\n  if( osClose(h) ){", "static void robust_close(unixFile *pFile, int h, int lineno){\n  if( osClose(h) ){\n    int savedErrno=errno;\n    ompSqliteCloseFailure(pFile);\n    errno=savedErrno;");
	// Reject alternate locking implementations before their first open.
	replace("  memset(p, 0, sizeof(unixFile));\n\n#ifdef SQLITE_ASSERT_NO_FILES", `  memset(p, 0, sizeof(unixFile));
  if( strcmp(pVfs->zName,"unix")!=0 ) return SQLITE_CANTOPEN;
  {
    char parent[MAX_PATHNAME+1];
    const char *slash=zPath ? strrchr(zPath,'/') : 0;
    int directory;
    if( !slash || slash==zPath || (size_t)(slash-zPath)>MAX_PATHNAME )
      return SQLITE_CANTOPEN;
    memcpy(parent,zPath,(size_t)(slash-zPath)); parent[slash-zPath]=0;
    directory=ompSqliteParent(parent);
    if( directory<0 ) return SQLITE_CANTOPEN;
    close(directory);
  }

#ifdef SQLITE_ASSERT_NO_FILES`);
	replace("open_finished:\n  if( rc!=SQLITE_OK ){\n    sqlite3_free(p->pPreallocatedUnused);\n  }\n  return rc;", "open_finished:\n  if( rc==SQLITE_OK ){\n    rc=ompSqliteAttach(p,zPath,flags);\n    if( rc!=SQLITE_OK ){\n      p->pMethod->xClose(pFile);\n      return rc;\n    }\n  }else{\n    sqlite3_free(p->pPreallocatedUnused);\n  }\n  return rc;");
	// A read-only connection never creates/repairs/rebuilds shm implicitly.
	replace("      if( 0==sqlite3_uri_boolean(pDbFd->zPath, \"readonly_shm\", 0) ){\n        pShmNode->hShm = robust_open(zShm, O_RDWR|O_CREAT|O_NOFOLLOW,\n                                     (sStat.st_mode&0777));\n      }", `      if( 0==sqlite3_uri_boolean(pDbFd->zPath, "readonly_shm", 0) ){
        int capabilities=O_RDWR|O_NOFOLLOW;
        /* RO may share an existing writable shm capability/readmarks, never
        ** create one. Per-connection guards still prohibit repair/extension. */
        if( !pDbFd->ompState->readonly ) capabilities|=O_CREAT;
        pShmNode->hShm = robust_open(zShm, capabilities,
                                     (sStat.st_mode&0777));
      }`);
	replace("      robustFchown(pShmNode->hShm, sStat.st_uid, sStat.st_gid);", "      rc=ompSqliteShmCheck(pDbFd,pShmNode);\n      if( rc!=SQLITE_OK ) goto shm_open_err;\n      robustFchown(pShmNode->hShm, sStat.st_uid, sStat.st_gid);");
	replace("  /* Make the new connection a child of the unixShmNode */", "  rc=ompSqliteShmCheck(pDbFd,pShmNode);\n  if( rc!=SQLITE_OK ) goto shm_open_err;\n\n  /* Make the new connection a child of the unixShmNode */");
	replace("  sqlite3_mutex_enter(pShmNode->pShmMutex);\n  if( pShmNode->isUnlocked ){", "  sqlite3_mutex_enter(pShmNode->pShmMutex);\n  rc=ompSqliteShmCheck(pDbFd,pShmNode);\n  if( rc!=SQLITE_OK ) goto shmpage_out;\n  if( pDbFd->ompState->readonly && bExtend && pShmNode->nRegion<=iRegion ){\n    rc=SQLITE_READONLY_CANTINIT; goto shmpage_out;\n  }\n  if( pShmNode->isUnlocked ){");
	replace("static int unixLockSharedMemory(unixFile *pDbFd, unixShmNode *pShmNode){\n  struct flock lock;\n  int rc = SQLITE_OK;", "static int unixLockSharedMemory(unixFile *pDbFd, unixShmNode *pShmNode){\n  struct flock lock;\n  int rc = SQLITE_OK;\n  rc=ompSqliteShmCheck(pDbFd,pShmNode);\n  if( rc!=SQLITE_OK ) return rc;");
	replace("    if( pShmNode->isReadonly ){\n      pShmNode->isUnlocked = 1;", "    if( pShmNode->isReadonly || pDbFd->ompState->readonly ){\n      pShmNode->isUnlocked = 1;");
	// Path-only VFS deletion cannot establish actual owned-file identity. All
	// supported journal/WAL deletes below are routed through a live unixFile.
	const deleteStart = source.indexOf("static int unixDelete(");
	const deleteEnd = source.indexOf("\n/*\n** Test the existence of or access permissions", deleteStart);
	if (deleteStart < 0 || deleteEnd < 0) throw new Error("unixDelete preimage rejected");
	source = source.slice(0, deleteStart) + `static int unixDelete(sqlite3_vfs *vfs, const char *path, int syncDirectory){
  UNUSED_PARAMETER(vfs); UNUSED_PARAMETER(path); UNUSED_PARAMETER(syncDirectory);
  return SQLITE_IOERR_AUTH; /* Unassociated deletion is deliberately forbidden. */
}
` + source.slice(deleteEnd);
	replace("  UNUSED_PARAMETER(NotUsed);\n  SimulateIOError( return SQLITE_IOERR_ACCESS; );", `  char parent[MAX_PATHNAME+1];
  const char *slash=zPath ? strrchr(zPath,'/') : 0;
  int directory;
  UNUSED_PARAMETER(NotUsed);
  if( !slash || slash==zPath || (size_t)(slash-zPath)>MAX_PATHNAME ) return SQLITE_IOERR_ACCESS;
  memcpy(parent,zPath,(size_t)(slash-zPath)); parent[slash-zPath]=0;
  directory=ompSqliteParent(parent);
  if( directory<0 ) return SQLITE_IOERR_ACCESS;
  close(directory);
  SimulateIOError( return SQLITE_IOERR_ACCESS; );`);
	replace("static int pager_error(Pager *pPager, int rc){", `${fragment("owned-pager.c")}\nstatic int pager_error(Pager *pPager, int rc){`);
	// There are exactly three calls with these two fixed argument spellings.
	const journalDelete = "sqlite3OsDelete(pPager->pVfs, pPager->zJournal, 0)";
	if (source.split(journalDelete).length !== 3) throw new Error("Journal mode deletion preimage rejected");
	source = source.replaceAll(journalDelete, "ompSqliteDeleteJournal(pPager,0)");
	replace("sqlite3OsDelete(pPager->pVfs, pPager->zJournal, pPager->extraSync)", "ompSqliteDeleteJournal(pPager,pPager->extraSync)");
	replace("    sqlite3OsClose(pWal->pWalFd);\n    if( isDelete ){\n      sqlite3BeginBenignMalloc();\n      sqlite3OsDelete(pWal->pVfs, pWal->zWalName, 0);\n      sqlite3EndBenignMalloc();\n    }", `    if( isDelete ){
      int guard=sqlite3OsFileControl(pWal->pWalFd,OMP_SQLITE_DELETE_CONTROL,0);
      if( rc==SQLITE_OK ) rc=guard;
    }
    sqlite3OsClose(pWal->pWalFd);`);
	replace("      osUnlink(pShmNode->zFilename);", "      if( ompSqliteShmCheck(pDbFd,pShmNode)==SQLITE_OK )\n        osUnlink(pShmNode->zFilename);");
	// VACUUM INTO is a core-owned, non-authoritative output, not a JS factory
	// registration. Authenticate source before output creation; force O_EXCL.
	replace("    db->openFlags |= SQLITE_OPEN_CREATE|SQLITE_OPEN_READWRITE;", "    db->openFlags |= SQLITE_OPEN_CREATE|SQLITE_OPEN_READWRITE|SQLITE_OPEN_EXCLUSIVE;");
	replace("  nDb = db->nDb;\n  rc = execSqlF(db, pzErrMsg, \"ATTACH %Q AS %s\", zOut, zDbVacuum);", `  if( pOut ){
    rc=ompSqliteVacuumSourceCheck(sqlite3PagerFile(sqlite3BtreePager(pMain)),SQLITE_OK);
    if( rc!=SQLITE_OK ) goto end_of_vacuum;
  }
  nDb = db->nDb;
  rc = execSqlF(db, pzErrMsg, "ATTACH %Q AS %s", zOut, zDbVacuum);`);
	replace("    db->mDbFlags |= DBFLAG_VacuumInto;", `    rc=ompSqliteVacuumBind(
        sqlite3PagerFile(sqlite3BtreePager(pMain)),id);
    if( rc!=SQLITE_OK ) goto end_of_vacuum;
    db->mDbFlags |= DBFLAG_VacuumInto;`);
	replace("  if( pDb ){\n    sqlite3BtreeClose(pDb->pBt);\n    pDb->pBt = 0;", `  if( pDb ){
    if( pOut ){
      int guard=ompSqliteVacuumFinish(
          sqlite3PagerFile(sqlite3BtreePager(pMain)),
          sqlite3PagerFile(sqlite3BtreePager(pDb->pBt)),rc);
      if( rc==SQLITE_OK ) rc=guard;
    }
    sqlite3BtreeClose(pDb->pBt);
    pDb->pBt = 0;`);
	replace("  sqlite3ResetAllSchemasOfConnection(db);\n\n  return rc;\n}\n\n#endif  /* SQLITE_OMIT_VACUUM", `  sqlite3ResetAllSchemasOfConnection(db);
  if( pOut ){
    int guard=ompSqliteVacuumSourceCheck(
        sqlite3PagerFile(sqlite3BtreePager(pMain)),rc);
    if( rc==SQLITE_OK ) rc=guard;
  }
  return rc;
}

#endif  /* SQLITE_OMIT_VACUUM`);
	const originalBegin = "SQLITE_PRIVATE int sqlite3BtreeBeginTrans(Btree *p, int wrflag, int *pSchemaVersion){";
	replace(originalBegin, "static int ompOriginalBtreeBeginTrans(Btree *p, int wrflag, int *pSchemaVersion){");
	const beginTail = "#ifndef SQLITE_OMIT_AUTOVACUUM\n\n/*\n** Set the pointer-map entries for all children of page pPage.";
	replace(beginTail, `SQLITE_PRIVATE int sqlite3BtreeBeginTrans(Btree *p, int wrflag, int *pSchemaVersion){
  sqlite3_file *fd=sqlite3PagerFile(p->pBt->pPager);
  int next=wrflag ? 2 : 1;
  int rc;
  if( fd && fd->pMethods ){
    rc=sqlite3OsFileControl(fd,OMP_SQLITE_TX_CONTROL,&next);
    if( rc!=SQLITE_OK ) return rc;
  }
  rc=ompOriginalBtreeBeginTrans(p,wrflag,pSchemaVersion);
  next=p->inTrans;
  if( fd && fd->pMethods ){
    int guard=sqlite3OsFileControl(fd,OMP_SQLITE_TX_CONTROL,&next);
    if( rc==SQLITE_OK ) rc=guard;
  }
  return rc;
}
\n${beginTail}`);
	replace("    p->inTrans = TRANS_NONE;\n    unlockBtreeIfUnused(pBt);\n  }\n\n  btreeIntegrity(p);", "    p->inTrans = TRANS_NONE;\n    unlockBtreeIfUnused(pBt);\n  }\n  {\n    sqlite3_file *fd=sqlite3PagerFile(pBt->pPager);\n    int next=p->inTrans;\n    if( fd && fd->pMethods ) (void)sqlite3OsFileControl(fd,OMP_SQLITE_TX_CONTROL,&next);\n  }\n\n  btreeIntegrity(p);");
	replace("static int sqlite3Close(sqlite3 *db, int forceZombie){", `${fragment("owned-close.c")}\nstatic int sqlite3Close(sqlite3 *db, int forceZombie){\n  OmpSqliteCloseContext ompClose;`);
	replace("  db->eOpenState = SQLITE_STATE_ZOMBIE;\n  sqlite3LeaveMutexAndCloseZombie(db);\n  return SQLITE_OK;", `  ompClose.count=0;
  ompClose.result=SQLITE_OK;
  /* The db mutex is held; no callback or unlock separates this test from
  ** CloseZombie's matching busy test. Never retain stack state on a zombie. */
  if( !connectionIsBusy(db) ) ompSqliteCloseCapture(db,&ompClose);
  db->eOpenState = SQLITE_STATE_ZOMBIE;
  sqlite3LeaveMutexAndCloseZombie(db);
  /* db may now be freed: inspect retained owned state only, never db. */
  return ompSqliteCloseResult(&ompClose);`);
	replace("SQLITE_API int sqlite3_file_control(sqlite3 *db, const char *zDbName, int op, void *pArg){", `${fragment("owned-core.c")}\nSQLITE_API int sqlite3_file_control(sqlite3 *db, const char *zDbName, int op, void *pArg){`);
	replace("    if( op==SQLITE_FCNTL_FILE_POINTER ){\n      *(sqlite3_file**)pArg = fd;", "    if( op==OMP_SQLITE_CONTROL ){\n      rc=ompSqliteCoreControl(db,pBtree,fd,pArg);\n    }else if( op==SQLITE_FCNTL_FILE_POINTER ){\n      *(sqlite3_file**)pArg = fd;");
	return source;
}
