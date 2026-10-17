/* Source-owned core deletion: a journal must have an actual live unixFile
** before it can be unlinked. Reopening is readonly/no-create and goes through
** the same exact-main association, generational and usage-time guards. */
static int ompSqliteDeleteJournal(Pager *pPager, int syncDirectory){
  int rc;
  if( !isOpen(pPager->jfd) ){
    int flags=SQLITE_OPEN_READONLY|SQLITE_OPEN_MAIN_JOURNAL;
    rc=sqlite3OsOpen(pPager->pVfs,pPager->zJournal,pPager->jfd,flags,0);
    if( rc!=SQLITE_OK ) return rc;
  }
  rc=sqlite3OsFileControl(pPager->jfd,OMP_SQLITE_DELETE_CONTROL,&syncDirectory);
  /* Once unlinked this file only permits close, so always close it here. */
  sqlite3OsClose(pPager->jfd);
  return rc;
}
