#define _DARWIN_C_SOURCE
#include <node_api.h>
#include <errno.h>
#include <fcntl.h>
#include <stdlib.h>
#include <stdio.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

static napi_value throw_errno(napi_env env, const char *operation) {
  char message[256];
  snprintf(message, sizeof(message), "%s failed: %s", operation, strerror(errno));
  napi_throw_error(env, NULL, message);
  return NULL;
}

static int32_t int_arg(napi_env env, napi_value value) {
  int32_t output = 0;
  napi_get_value_int32(env, value, &output);
  return output;
}

static char *string_arg(napi_env env, napi_value value) {
  size_t length = 0;
  napi_get_value_string_utf8(env, value, NULL, 0, &length);
  char *output = malloc(length + 1);
  if (output == NULL) return NULL;
  napi_get_value_string_utf8(env, value, output, length + 1, &length);
  return output;
}

static napi_value open_at(napi_env env, napi_callback_info info) {
  size_t argc = 4;
  napi_value argv[4];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  if (argc != 4) { napi_throw_type_error(env, NULL, "openAt requires dirfd, leaf, flags, mode"); return NULL; }
  char *leaf = string_arg(env, argv[1]);
  if (leaf == NULL) { napi_throw_error(env, NULL, "allocation failed"); return NULL; }
  int fd = openat(int_arg(env, argv[0]), leaf, int_arg(env, argv[2]), (mode_t)int_arg(env, argv[3]));
  free(leaf);
  if (fd < 0) return throw_errno(env, "openat");
  napi_value result;
  napi_create_int32(env, fd, &result);
  return result;
}

static napi_value mkdir_at(napi_env env, napi_callback_info info) {
  size_t argc = 3;
  napi_value argv[3];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  if (argc != 3) { napi_throw_type_error(env, NULL, "mkdirAt requires dirfd, leaf, mode"); return NULL; }
  char *leaf = string_arg(env, argv[1]);
  if (leaf == NULL) { napi_throw_error(env, NULL, "allocation failed"); return NULL; }
  int status = mkdirat(int_arg(env, argv[0]), leaf, (mode_t)int_arg(env, argv[2]));
  free(leaf);
  if (status != 0) return throw_errno(env, "mkdirat");
  napi_value result;
  napi_get_undefined(env, &result);
  return result;
}

static napi_value rename_at(napi_env env, napi_callback_info info) {
  size_t argc = 4;
  napi_value argv[4];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  if (argc != 4) { napi_throw_type_error(env, NULL, "renameAt requires source dirfd/leaf and destination dirfd/leaf"); return NULL; }
  char *source = string_arg(env, argv[1]);
  char *destination = string_arg(env, argv[3]);
  if (source == NULL || destination == NULL) {
    free(source); free(destination); napi_throw_error(env, NULL, "allocation failed"); return NULL;
  }
  int status = renameat(int_arg(env, argv[0]), source, int_arg(env, argv[2]), destination);
  free(source); free(destination);
  if (status != 0) return throw_errno(env, "renameat");
  napi_value result;
  napi_get_undefined(env, &result);
  return result;
}

static napi_value init(napi_env env, napi_value exports) {
  napi_property_descriptor properties[] = {
    { "openAt", NULL, open_at, NULL, NULL, NULL, napi_default, NULL },
    { "mkdirAt", NULL, mkdir_at, NULL, NULL, NULL, napi_default, NULL },
    { "renameAt", NULL, rename_at, NULL, NULL, NULL, napi_default, NULL },
  };
  napi_define_properties(env, exports, 3, properties);
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, init)
