/* Parent-run build metadata only. Links solely to the just-built SQLite. */
#include <stdio.h>
#include <string.h>
#include "sqlite3.h"
int main(void){
  int i;
  const char *option;
  printf("{\"version\":\"%s\",\"sourceId\":\"%s\",\"compileOptions\":[",
         sqlite3_libversion(),sqlite3_sourceid());
  for(i=0; (option=sqlite3_compileoption_get(i))!=0; i++){
    /* SQLite compile option spellings contain no JSON escapes in this build. */
    if( strpbrk(option,"\"\\\n\r") ) return 2;
    printf("%s\"%s\"",i ? "," : "",option);
  }
  puts("]}");
  return 0;
}
