#include <errno.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <signal.h>
#include <sys/types.h>

enum sandbox_filter_type {
  SANDBOX_FILTER_NONE = 0,
  SANDBOX_FILTER_PATH = 1,
};

extern int sandbox_check(pid_t pid, const char *operation,
                         enum sandbox_filter_type type, ...);

static int parse_pid(const char *value, pid_t *pid) {
  char *end = NULL;
  errno = 0;
  long parsed = strtol(value, &end, 10);
  if (errno != 0 || end == value || *end != '\0' || parsed <= 0 || parsed > INT_MAX) {
    return 0;
  }
  *pid = (pid_t)parsed;
  return 1;
}

int main(int argc, char **argv) {
  if (argc < 5 || (argv[1][0] != 'l' && argv[1][0] != 'k')) {
    fprintf(stderr, "usage: %s list|kill denied-path allowed-path pid...\n", argv[0]);
    return 64;
  }

  int should_kill = argv[1][0] == 'k';
  int signal_failed = 0;
  for (int index = 4; index < argc; index += 1) {
    pid_t pid;
    if (!parse_pid(argv[index], &pid)) {
      continue;
    }
    int denied = sandbox_check(pid, "file-read-data", SANDBOX_FILTER_PATH, argv[2]);
    int allowed = sandbox_check(pid, "file-read-data", SANDBOX_FILTER_PATH, argv[3]);
    if (denied > 0 && allowed == 0) {
      if (!should_kill || kill(pid, SIGKILL) == 0 || errno == ESRCH) {
        printf("%d\n", pid);
      } else {
        signal_failed = 1;
      }
    }
  }
  return signal_failed ? 70 : 0;
}
