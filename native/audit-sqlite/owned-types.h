/* Source-owned unix VFS state; included inside the pinned amalgamation. */
#include <stdatomic.h>
#include <stdint.h>
#define OMP_SQLITE_CONTROL 0x4f4d5001
#define OMP_SQLITE_TX_CONTROL 0x4f4d5002
#define OMP_SQLITE_DELETE_CONTROL 0x4f4d5003
#define OMP_SQLITE_MAGIC 0x4f4d5053u
#define OMP_SQLITE_WORDS 64
#define OMP_SQLITE_BYTES 256

typedef struct OmpSqliteState OmpSqliteState;
struct OmpSqliteState {
  sqlite3_mutex *mutex;
  struct unixFile *mainFile;
  struct unixFile *walFile;
  struct unixFile *journalFile;
  OmpSqliteState *backupSource;
  int backupOutput;
  sqlite3_uint64 connectionGeneration;
  sqlite3_uint64 transactionGeneration;
  sqlite3_uint64 shmGeneration;
  sqlite3_uint64 walTransactionGeneration;
  sqlite3_uint64 shmTransactionGeneration;
  struct stat previousWalStat;
  struct stat previousShmStat;
  int walSeen;
  int shmSeen;
  sqlite3_uint64 expectedDevice;
  sqlite3_uint64 expectedInode;
  struct stat shmStat;
  void *shmNode;
  int parentFd;
  int references;
  int armed;
  int fault;
  int readonly;
  int transactionState;
  char *parentPath;
};
static int ompSqliteShmCheck(struct unixFile*, struct unixShmNode*);
