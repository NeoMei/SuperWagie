#include <node_api.h>
#include <errno.h>
#include <fcntl.h>
#include <stdlib.h>
#include <stdio.h>
#include <string.h>

#ifdef _WIN32
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <winternl.h>
#include <io.h>
#include <stdint.h>
#include <uv.h>

#define SW_O_DIRECTORY 0x40000000
#ifndef FILE_OPEN_REPARSE_POINT
#define FILE_OPEN_REPARSE_POINT 0x00200000
#endif

typedef NTSTATUS (NTAPI *nt_create_file_fn)(PHANDLE, ACCESS_MASK, POBJECT_ATTRIBUTES,
  PIO_STATUS_BLOCK, PLARGE_INTEGER, ULONG, ULONG, ULONG, ULONG, PVOID, ULONG);
typedef NTSTATUS (NTAPI *nt_set_information_file_fn)(HANDLE, PIO_STATUS_BLOCK, PVOID, ULONG,
  FILE_INFORMATION_CLASS);
typedef ULONG (WINAPI *rtl_nt_status_to_dos_error_fn)(NTSTATUS);

static napi_value throw_windows(napi_env env, const char *operation, DWORD error) {
  const char *code = "EIO";
  if (error == ERROR_FILE_EXISTS || error == ERROR_ALREADY_EXISTS) code = "EEXIST";
  else if (error == ERROR_FILE_NOT_FOUND || error == ERROR_PATH_NOT_FOUND) code = "ENOENT";
  else if (error == ERROR_ACCESS_DENIED || error == ERROR_CANT_ACCESS_FILE
    || error == ERROR_REPARSE_TAG_INVALID || error == ERROR_REPARSE_TAG_MISMATCH) code = "SYMLINK_FORBIDDEN";
  char message[128];
  snprintf(message, sizeof(message), "%s failed: %s (%lu)", operation, code, (unsigned long)error);
  napi_throw_error(env, code, message);
  return NULL;
}

static napi_value throw_ntstatus(napi_env env, const char *operation, NTSTATUS status) {
  HMODULE ntdll = GetModuleHandleW(L"ntdll.dll");
  rtl_nt_status_to_dos_error_fn convert = ntdll == NULL ? NULL
    : (rtl_nt_status_to_dos_error_fn)GetProcAddress(ntdll, "RtlNtStatusToDosError");
  return throw_windows(env, operation, convert == NULL ? ERROR_GEN_FAILURE : convert(status));
}

static wchar_t *wide_arg(napi_env env, napi_value value, USHORT *byte_length) {
  size_t length = 0;
  if (napi_get_value_string_utf16(env, value, NULL, 0, &length) != napi_ok
    || length == 0 || length > 32760) return NULL;
  wchar_t *output = (wchar_t *)calloc(length + 1, sizeof(wchar_t));
  if (output == NULL) return NULL;
  if (napi_get_value_string_utf16(env, value, (char16_t *)output, length + 1, &length) != napi_ok) {
    free(output);
    return NULL;
  }
  for (size_t index = 0; index < length; index++) {
    if (output[index] == L'\0' || output[index] == L'\\' || output[index] == L'/' || output[index] == L':') {
      free(output);
      return NULL;
    }
  }
  if ((length == 1 && output[0] == L'.')
    || (length == 2 && output[0] == L'.' && output[1] == L'.')) {
    free(output);
    return NULL;
  }
  *byte_length = (USHORT)(length * sizeof(wchar_t));
  return output;
}

static HANDLE handle_arg(napi_env env, napi_value value) {
  int32_t descriptor = -1;
  if (napi_get_value_int32(env, value, &descriptor) != napi_ok || descriptor < 0) return INVALID_HANDLE_VALUE;
  uv_os_fd_t handle = uv_get_osfhandle(descriptor);
  return handle == INVALID_HANDLE_VALUE ? INVALID_HANDLE_VALUE : (HANDLE)handle;
}

static int32_t int_arg(napi_env env, napi_value value) {
  int32_t output = 0;
  napi_get_value_int32(env, value, &output);
  return output;
}

static NTSTATUS open_relative_handle(HANDLE root, const wchar_t *leaf, USHORT leaf_bytes,
  ACCESS_MASK access, ULONG disposition, ULONG options, HANDLE *output) {
  HMODULE ntdll = GetModuleHandleW(L"ntdll.dll");
  nt_create_file_fn create_file = ntdll == NULL ? NULL
    : (nt_create_file_fn)GetProcAddress(ntdll, "NtCreateFile");
  if (create_file == NULL) return (NTSTATUS)0xC0000002L;
  UNICODE_STRING name;
  name.Length = leaf_bytes;
  name.MaximumLength = leaf_bytes;
  name.Buffer = (PWSTR)leaf;
  OBJECT_ATTRIBUTES attributes;
  InitializeObjectAttributes(&attributes, &name, OBJ_CASE_INSENSITIVE, root, NULL);
  IO_STATUS_BLOCK io_status;
  return create_file(output, access, &attributes, &io_status, NULL,
    FILE_ATTRIBUTE_NORMAL, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
    disposition, options | FILE_OPEN_REPARSE_POINT | FILE_SYNCHRONOUS_IO_NONALERT,
    NULL, 0);
}

static int handle_is_reparse(HANDLE handle) {
  FILE_ATTRIBUTE_TAG_INFO tag;
  if (!GetFileInformationByHandleEx(handle, FileAttributeTagInfo, &tag, sizeof(tag))) return -1;
  return (tag.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0;
}

static napi_value open_at(napi_env env, napi_callback_info info) {
  size_t argc = 4;
  napi_value argv[4];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  if (argc != 4) { napi_throw_type_error(env, NULL, "openAt requires dirfd, leaf, flags, mode"); return NULL; }
  HANDLE root = handle_arg(env, argv[0]);
  USHORT leaf_bytes = 0;
  wchar_t *leaf = wide_arg(env, argv[1], &leaf_bytes);
  int flags = int_arg(env, argv[2]);
  if (root == INVALID_HANDLE_VALUE || leaf == NULL) {
    free(leaf);
    napi_throw_error(env, "RELATIVE_PATH_REQUIRED", "openAt requires a valid directory handle and leaf");
    return NULL;
  }
  int directory = (flags & SW_O_DIRECTORY) != 0;
  flags &= ~SW_O_DIRECTORY;
  ACCESS_MASK access = SYNCHRONIZE | FILE_READ_ATTRIBUTES;
  if ((flags & O_WRONLY) != 0) access |= FILE_WRITE_DATA | FILE_WRITE_ATTRIBUTES;
  else access |= FILE_READ_DATA;
  ULONG disposition = ((flags & O_CREAT) != 0 && (flags & O_EXCL) != 0) ? FILE_CREATE : FILE_OPEN;
  HANDLE opened = INVALID_HANDLE_VALUE;
  NTSTATUS status = open_relative_handle(root, leaf, leaf_bytes, access, disposition,
    directory ? FILE_DIRECTORY_FILE : FILE_NON_DIRECTORY_FILE, &opened);
  free(leaf);
  if (status < 0) return throw_ntstatus(env, "NtCreateFile", status);
  int reparse = handle_is_reparse(opened);
  if (reparse != 0) {
    DWORD error = reparse < 0 ? GetLastError() : ERROR_CANT_ACCESS_FILE;
    CloseHandle(opened);
    return throw_windows(env, "reparse validation", error);
  }
  int descriptor = uv_open_osfhandle((uv_os_fd_t)opened);
  if (descriptor < 0) {
    CloseHandle(opened);
    return throw_windows(env, "_open_osfhandle", ERROR_INVALID_HANDLE);
  }
  napi_value result;
  napi_create_int32(env, descriptor, &result);
  return result;
}

static napi_value mkdir_at(napi_env env, napi_callback_info info) {
  size_t argc = 3;
  napi_value argv[3];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  if (argc != 3) { napi_throw_type_error(env, NULL, "mkdirAt requires dirfd, leaf, mode"); return NULL; }
  HANDLE root = handle_arg(env, argv[0]);
  USHORT leaf_bytes = 0;
  wchar_t *leaf = wide_arg(env, argv[1], &leaf_bytes);
  if (root == INVALID_HANDLE_VALUE || leaf == NULL) {
    free(leaf);
    napi_throw_error(env, "RELATIVE_PATH_REQUIRED", "mkdirAt requires a valid directory handle and leaf");
    return NULL;
  }
  HANDLE created = INVALID_HANDLE_VALUE;
  NTSTATUS status = open_relative_handle(root, leaf, leaf_bytes,
    SYNCHRONIZE | FILE_READ_ATTRIBUTES | FILE_LIST_DIRECTORY,
    FILE_CREATE, FILE_DIRECTORY_FILE, &created);
  free(leaf);
  if (status < 0) return throw_ntstatus(env, "NtCreateFile(directory)", status);
  CloseHandle(created);
  napi_value result;
  napi_get_undefined(env, &result);
  return result;
}

static napi_value rename_at(napi_env env, napi_callback_info info) {
  size_t argc = 4;
  napi_value argv[4];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  if (argc != 4) { napi_throw_type_error(env, NULL, "renameAt requires source dirfd/leaf and destination dirfd/leaf"); return NULL; }
  HANDLE source_root = handle_arg(env, argv[0]);
  HANDLE destination_root = handle_arg(env, argv[2]);
  USHORT source_bytes = 0;
  USHORT destination_bytes = 0;
  wchar_t *source = wide_arg(env, argv[1], &source_bytes);
  wchar_t *destination = wide_arg(env, argv[3], &destination_bytes);
  if (source_root == INVALID_HANDLE_VALUE || destination_root == INVALID_HANDLE_VALUE
    || source == NULL || destination == NULL) {
    free(source); free(destination);
    napi_throw_error(env, "RELATIVE_PATH_REQUIRED", "renameAt requires valid directory handles and leaves");
    return NULL;
  }
  HANDLE source_handle = INVALID_HANDLE_VALUE;
  NTSTATUS status = open_relative_handle(source_root, source, source_bytes,
    DELETE | SYNCHRONIZE | FILE_READ_ATTRIBUTES,
    FILE_OPEN, FILE_NON_DIRECTORY_FILE, &source_handle);
  free(source);
  if (status < 0) { free(destination); return throw_ntstatus(env, "NtCreateFile(rename source)", status); }
  if (handle_is_reparse(source_handle) != 0) {
    CloseHandle(source_handle); free(destination);
    return throw_windows(env, "reparse validation", ERROR_CANT_ACCESS_FILE);
  }
  typedef struct {
    BOOLEAN ReplaceIfExists;
    HANDLE RootDirectory;
    ULONG FileNameLength;
    WCHAR FileName[1];
  } sw_file_rename_information;
  size_t info_size = sizeof(sw_file_rename_information) + destination_bytes;
  sw_file_rename_information *rename_info = (sw_file_rename_information *)calloc(1, info_size);
  if (rename_info == NULL) {
    CloseHandle(source_handle); free(destination);
    napi_throw_error(env, NULL, "allocation failed");
    return NULL;
  }
  rename_info->ReplaceIfExists = 1;
  rename_info->RootDirectory = destination_root;
  rename_info->FileNameLength = destination_bytes;
  memcpy(rename_info->FileName, destination, destination_bytes);
  HMODULE ntdll = GetModuleHandleW(L"ntdll.dll");
  nt_set_information_file_fn set_information = ntdll == NULL ? NULL
    : (nt_set_information_file_fn)GetProcAddress(ntdll, "NtSetInformationFile");
  IO_STATUS_BLOCK io_status;
  status = set_information == NULL ? (NTSTATUS)0xC0000002L
    : set_information(source_handle, &io_status, rename_info, (ULONG)info_size,
      (FILE_INFORMATION_CLASS)10);
  free(rename_info); free(destination); CloseHandle(source_handle);
  if (status < 0) return throw_ntstatus(env, "NtSetInformationFile", status);
  napi_value result;
  napi_get_undefined(env, &result);
  return result;
}

#else

#define _DARWIN_C_SOURCE
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

#endif

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
