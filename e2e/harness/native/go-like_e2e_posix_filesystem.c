#define _DARWIN_C_SOURCE 1
#define _GNU_SOURCE 1
#define _POSIX_C_SOURCE 200809L

#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#if defined(LGFS_TEST_BARRIERS)
#include <poll.h>
#endif
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <time.h>
#include <unistd.h>

#include "go-like_e2e_posix_filesystem_protocol.h"

#if defined(__APPLE__)
#include <libproc.h>
#include <sys/proc.h>
#elif defined(__linux__)
#include <linux/fs.h>
#include <sys/syscall.h>
#endif

#if defined(__linux__) && !defined(LGFS_PROC_SELF_FD_ROOT)
#define LGFS_PROC_SELF_FD_ROOT "/proc/self/fd"
#endif

#ifndef PATH_MAX
#define PATH_MAX 4096
#endif

struct lgfs_request {
  uint16_t opcode;
  uint64_t request_id;
  uint32_t handle_id;
  uint32_t flags;
  uint32_t payload_length;
  uint8_t *payload;
};

struct lgfs_handle {
  int active;
  int fd;
  int private_directory;
  dev_t device;
  ino_t inode;
  uint32_t parent_id;
  dev_t parent_device;
  ino_t parent_inode;
  char name[LGFS_MAX_COMPONENT + 1U];
};

struct lgfs_response {
  uint16_t opcode;
  uint64_t request_id;
  uint32_t status;
  int error_number;
  uint32_t handle_id;
  uint8_t *payload;
  uint32_t payload_length;
};

static struct lgfs_handle handles[LGFS_MAX_HANDLES];
static uint32_t next_handle_id = 1U;

static uint16_t read_u16(const uint8_t *value) {
  return (uint16_t)value[0] | ((uint16_t)value[1] << 8U);
}

static uint32_t read_u32(const uint8_t *value) {
  return (uint32_t)value[0] | ((uint32_t)value[1] << 8U) | ((uint32_t)value[2] << 16U) |
         ((uint32_t)value[3] << 24U);
}

static uint64_t read_u64(const uint8_t *value) {
  uint64_t result = 0U;
  for (uint32_t index = 0U; index < 8U; index += 1U) {
    result |= ((uint64_t)value[index]) << (index * 8U);
  }
  return result;
}

static void write_u16(uint8_t *target, uint16_t value) {
  target[0] = (uint8_t)(value & 0xffU);
  target[1] = (uint8_t)((value >> 8U) & 0xffU);
}

static void write_u32(uint8_t *target, uint32_t value) {
  for (uint32_t index = 0U; index < 4U; index += 1U) {
    target[index] = (uint8_t)((value >> (index * 8U)) & 0xffU);
  }
}

static void write_u64(uint8_t *target, uint64_t value) {
  for (uint32_t index = 0U; index < 8U; index += 1U) {
    target[index] = (uint8_t)((value >> (index * 8U)) & 0xffU);
  }
}

static int read_all(int fd, uint8_t *target, size_t length, int allow_eof) {
  size_t offset = 0U;
  while (offset < length) {
    ssize_t observed = read(fd, target + offset, length - offset);
    if (observed == 0) return allow_eof && offset == 0U ? 1 : -1;
    if (observed < 0) {
      if (errno == EINTR) continue;
      return -1;
    }
    offset += (size_t)observed;
  }
  return 0;
}

static int write_all(int fd, const uint8_t *value, size_t length) {
  size_t offset = 0U;
  while (offset < length) {
    ssize_t written = write(fd, value + offset, length - offset);
    if (written < 0) {
      if (errno == EINTR) continue;
      return -1;
    }
    if (written == 0) {
      errno = EIO;
      return -1;
    }
    offset += (size_t)written;
  }
  return 0;
}

enum lgfs_test_barrier_stage {
  LGFS_TEST_BEFORE_CREATE_CHILD = 1,
  LGFS_TEST_AFTER_MKDIR_BEFORE_OPEN = 2,
  LGFS_TEST_BEFORE_OPEN_FINAL = 3,
  LGFS_TEST_AFTER_OPEN_FINAL = 4,
  LGFS_TEST_AFTER_TEMP_FSYNC_BEFORE_LINK = 5,
  LGFS_TEST_AFTER_LINK_BEFORE_TEMP_UNLINK = 6,
  LGFS_TEST_BEFORE_CLEANUP_RENAME = 7,
  LGFS_TEST_AFTER_CLEANUP_RENAME_BEFORE_IDENTITY_CHECK = 8,
  LGFS_TEST_BEFORE_CLEANUP_UNLINK = 9
};

#if defined(LGFS_TEST_BARRIERS)
#ifndef LGFS_TEST_BARRIER_STAGE
#error "LGFS_TEST_BARRIER_STAGE is required when test barriers are enabled"
#endif
#define LGFS_TEST_BARRIER_NOTIFY_FD 3
#define LGFS_TEST_BARRIER_RESUME_FD 4
#define LGFS_TEST_BARRIER_TIMEOUT_MS 5000U

static int test_barrier_now(uint64_t *milliseconds) {
  struct timespec observed;
  if (clock_gettime(CLOCK_MONOTONIC, &observed) < 0) return -1;
  *milliseconds = (uint64_t)observed.tv_sec * UINT64_C(1000) +
                  (uint64_t)observed.tv_nsec / UINT64_C(1000000);
  return 0;
}

static int test_barrier(uint32_t stage) {
  static int fired = 0;
  if (stage != (uint32_t)LGFS_TEST_BARRIER_STAGE || fired) return 0;
  fired = 1;
  uint8_t frame[4];
  write_u32(frame, stage);
  if (write_all(LGFS_TEST_BARRIER_NOTIFY_FD, frame, sizeof(frame)) < 0) return -1;

  uint64_t started = 0U;
  if (test_barrier_now(&started) < 0) return -1;
  size_t offset = 0U;
  while (offset < sizeof(frame)) {
    uint64_t now = 0U;
    if (test_barrier_now(&now) < 0) return -1;
    if (now - started >= LGFS_TEST_BARRIER_TIMEOUT_MS) {
      errno = ETIMEDOUT;
      return -1;
    }
    uint64_t remaining = LGFS_TEST_BARRIER_TIMEOUT_MS - (now - started);
    struct pollfd descriptor = {
        .fd = LGFS_TEST_BARRIER_RESUME_FD,
        .events = POLLIN,
        .revents = 0,
    };
    int observed = poll(&descriptor, 1U, (int)remaining);
    if (observed == 0) {
      errno = ETIMEDOUT;
      return -1;
    }
    if (observed < 0) {
      if (errno == EINTR) continue;
      return -1;
    }
    if ((descriptor.revents & (POLLERR | POLLHUP | POLLNVAL)) != 0) {
      errno = EPIPE;
      return -1;
    }
    ssize_t count = read(LGFS_TEST_BARRIER_RESUME_FD, frame + offset, sizeof(frame) - offset);
    if (count < 0) {
      if (errno == EINTR) continue;
      return -1;
    }
    if (count == 0) {
      errno = EPIPE;
      return -1;
    }
    offset += (size_t)count;
  }
  if (read_u32(frame) != stage) {
    errno = EPROTO;
    return -1;
  }
  return 0;
}
#else
#define test_barrier(stage) ((void)(stage), 0)
#endif

static int valid_component_bytes(const uint8_t *value, uint32_t length) {
  if (length == 0U || length > LGFS_MAX_COMPONENT) return 0;
  if (length == 1U && value[0] == '.') return 0;
  if (length == 2U && value[0] == '.' && value[1] == '.') return 0;
  for (uint32_t index = 0U; index < length; index += 1U) {
    if (value[index] == 0U || value[index] == '/') return 0;
  }
  return 1;
}

static int component_string(const uint8_t *value, uint32_t length,
                            char target[LGFS_MAX_COMPONENT + 1U]) {
  if (!valid_component_bytes(value, length)) return -1;
  memcpy(target, value, length);
  target[length] = '\0';
  return 0;
}

static int private_directory_metadata(const struct stat *metadata) {
  return S_ISDIR(metadata->st_mode) && metadata->st_uid == geteuid() &&
         (metadata->st_mode & 0077U) == 0U;
}

static int private_file_metadata(const struct stat *metadata) {
  return S_ISREG(metadata->st_mode) && metadata->st_uid == geteuid() &&
         (metadata->st_mode & 0077U) == 0U;
}

static int same_identity(const struct stat *left, const struct stat *right) {
  return left->st_dev == right->st_dev && left->st_ino == right->st_ino;
}

static struct lgfs_handle *selected_handle(uint32_t id) {
  if (id == 0U || id >= LGFS_MAX_HANDLES || !handles[id].active) return NULL;
  return &handles[id];
}

static struct lgfs_handle *parent_handle(const struct lgfs_handle *child) {
  struct lgfs_handle *parent = selected_handle(child->parent_id);
  if (parent != NULL && parent->device == child->parent_device &&
      parent->inode == child->parent_inode) {
    return parent;
  }
  for (uint32_t id = 1U; id < next_handle_id; id += 1U) {
    if (handles[id].active && handles[id].device == child->parent_device &&
        handles[id].inode == child->parent_inode) {
      return &handles[id];
    }
  }
  errno = EBADF;
  return NULL;
}

static int open_directory_at(int parent_fd, const char *name) {
  return openat(parent_fd, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
}

static int fd_path(int fd, char target[PATH_MAX]) {
#if defined(__APPLE__)
  if (fcntl(fd, F_GETPATH, target) < 0) return -1;
  target[PATH_MAX - 1] = '\0';
  if (target[0] != '/') {
    errno = ESTALE;
    return -1;
  }
  return 0;
#elif defined(__linux__)
  char link_path[64];
  int length = snprintf(link_path, sizeof(link_path), LGFS_PROC_SELF_FD_ROOT "/%d", fd);
  if (length < 0 || (size_t)length >= sizeof(link_path)) {
    errno = EOVERFLOW;
    return -1;
  }
  ssize_t observed = readlink(link_path, target, PATH_MAX - 1U);
  if (observed < 0) {
    if (errno == ENOENT || errno == ENOTDIR || errno == EACCES || errno == EPERM) {
      errno = ENOTSUP;
    }
    return -1;
  }
  if (observed == 0 || observed >= PATH_MAX - 1) {
    errno = EOVERFLOW;
    return -1;
  }
  target[observed] = '\0';
  if (target[0] != '/' || strstr(target, " (deleted)") != NULL) {
    errno = ESTALE;
    return -1;
  }
  return 0;
#else
  (void)fd;
  (void)target;
  errno = ENOTSUP;
  return -1;
#endif
}

static int expected_child_path(int parent_fd, const char *name, int child_fd,
                               char target[PATH_MAX]) {
  char parent_path[PATH_MAX];
  if (fd_path(parent_fd, parent_path) < 0 || fd_path(child_fd, target) < 0) return -1;
  size_t parent_length = strlen(parent_path);
  size_t name_length = strlen(name);
  if (parent_length + 1U + name_length >= PATH_MAX) {
    errno = ENAMETOOLONG;
    return -1;
  }
  char expected[PATH_MAX];
  memcpy(expected, parent_path, parent_length);
  expected[parent_length] = '/';
  memcpy(expected + parent_length + 1U, name, name_length + 1U);
  if (strcmp(expected, target) != 0) {
    errno = ESTALE;
    return -1;
  }
  return 0;
}

static int validate_handle_recursive(uint32_t id, uint32_t depth) {
  if (depth > 128U) {
    errno = ELOOP;
    return -1;
  }
  struct lgfs_handle *handle = selected_handle(id);
  if (handle == NULL) {
    errno = EBADF;
    return -1;
  }
  struct stat retained;
  if (fstat(handle->fd, &retained) < 0) return -1;
  if (!S_ISDIR(retained.st_mode) || retained.st_dev != handle->device ||
      retained.st_ino != handle->inode ||
      (handle->private_directory && !private_directory_metadata(&retained))) {
    errno = ESTALE;
    return -1;
  }
  if (handle->parent_id == 0U) return 0;
  struct lgfs_handle *parent = parent_handle(handle);
  if (parent == NULL) return -1;
  uint32_t parent_id = (uint32_t)(parent - handles);
  if (validate_handle_recursive(parent_id, depth + 1U) < 0) return -1;
  int observed_fd = open_directory_at(parent->fd, handle->name);
  if (observed_fd < 0) return -1;
  struct stat observed;
  int result = fstat(observed_fd, &observed);
  int saved_errno = errno;
  if (close(observed_fd) < 0 && result == 0) {
    result = -1;
    saved_errno = errno;
  }
  if (result < 0) {
    errno = saved_errno;
    return -1;
  }
  if (observed.st_dev != handle->device || observed.st_ino != handle->inode) {
    errno = ESTALE;
    return -1;
  }
  return 0;
}

static uint32_t add_handle(int fd, int private_directory, uint32_t parent_id,
                           const char *name) {
  if (next_handle_id >= LGFS_MAX_HANDLES) {
    errno = EMFILE;
    return 0U;
  }
  struct stat metadata;
  if (fstat(fd, &metadata) < 0) return 0U;
  uint32_t id = next_handle_id;
  next_handle_id += 1U;
  handles[id].active = 1;
  handles[id].fd = fd;
  handles[id].private_directory = private_directory;
  handles[id].device = metadata.st_dev;
  handles[id].inode = metadata.st_ino;
  handles[id].parent_id = parent_id;
  handles[id].parent_device = 0;
  handles[id].parent_inode = 0;
  handles[id].name[0] = '\0';
  if (parent_id != 0U) {
    struct lgfs_handle *parent = selected_handle(parent_id);
    if (parent == NULL) {
      handles[id].active = 0;
      errno = EBADF;
      return 0U;
    }
    handles[id].parent_device = parent->device;
    handles[id].parent_inode = parent->inode;
  }
  if (name != NULL) {
    size_t length = strlen(name);
    if (length > LGFS_MAX_COMPONENT) {
      handles[id].active = 0;
      errno = ENAMETOOLONG;
      return 0U;
    }
    memcpy(handles[id].name, name, length + 1U);
  }
  return id;
}

static int active_child_exists(uint32_t parent_id) {
  for (uint32_t id = 1U; id < next_handle_id; id += 1U) {
    if (handles[id].active && handles[id].parent_id == parent_id) return 1;
  }
  return 0;
}

static void close_all_handles(void) {
  for (uint32_t id = next_handle_id; id > 1U; id -= 1U) {
    uint32_t selected = id - 1U;
    if (handles[selected].active) {
      (void)close(handles[selected].fd);
      handles[selected].active = 0;
    }
  }
}

static int allocate_path_payload(int fd, uint8_t **payload, uint32_t *payload_length) {
  char path[PATH_MAX];
  if (fd_path(fd, path) < 0) return -1;
  size_t length = strlen(path);
  if (length == 0U || length > UINT32_MAX) {
    errno = EOVERFLOW;
    return -1;
  }
  uint8_t *result = malloc(length);
  if (result == NULL) return -1;
  memcpy(result, path, length);
  *payload = result;
  *payload_length = (uint32_t)length;
  return 0;
}

static uint32_t portable_error_code(int error_number) {
  if (error_number == ENOENT) return LGFS_ERROR_NO_ENTRY;
  if (error_number == EEXIST) return LGFS_ERROR_EXISTS;
  if (error_number == ELOOP) return LGFS_ERROR_SYMBOLIC_LINK;
  if (error_number == ENOTDIR) return LGFS_ERROR_NOT_DIRECTORY;
  if (error_number == EISDIR) return LGFS_ERROR_IS_DIRECTORY;
  if (error_number == EACCES) return LGFS_ERROR_ACCESS;
  if (error_number == EPERM) return LGFS_ERROR_PERMISSION;
  if (error_number == ENOSPC) return LGFS_ERROR_NO_SPACE;
  if (error_number == EMFILE) return LGFS_ERROR_PROCESS_FILE_LIMIT;
  if (error_number == ENFILE) return LGFS_ERROR_SYSTEM_FILE_LIMIT;
  if (error_number == EIO) return LGFS_ERROR_IO;
  if (error_number == EOVERFLOW) return LGFS_ERROR_OVERFLOW;
  if (error_number == EBADF) return LGFS_ERROR_BAD_DESCRIPTOR;
  if (error_number == ENOTEMPTY) return LGFS_ERROR_NOT_EMPTY;
  if (error_number == EXDEV) return LGFS_ERROR_CROSS_DEVICE;
  if (error_number == EINTR) return LGFS_ERROR_INTERRUPTED;
  if (error_number == ETIMEDOUT) return LGFS_ERROR_TIMED_OUT;
  if (error_number == ESTALE) return LGFS_ERROR_STALE;
  if (error_number == EBUSY) return LGFS_ERROR_BUSY;
  if (error_number == EFBIG) return LGFS_ERROR_TOO_LARGE;
  if (error_number == EINVAL) return LGFS_ERROR_INVALID;
  if (error_number == ENOTSUP) return LGFS_ERROR_UNSUPPORTED;
  return LGFS_ERROR_UNKNOWN;
}

static void response_error(struct lgfs_response *response, uint32_t status, int error_number) {
  int selected = error_number == 0 ? EIO : error_number;
  response->status = status;
  response->error_number = selected;
  response->handle_id = portable_error_code(selected);
}

static int parse_request(struct lgfs_request *request) {
  uint8_t header[LGFS_HEADER_SIZE];
  int header_result = read_all(STDIN_FILENO, header, sizeof(header), 1);
  if (header_result != 0) return header_result;
  if (read_u32(header) != LGFS_MAGIC || read_u16(header + 4U) != LGFS_VERSION ||
      read_u32(header + 28U) != 0U) {
    errno = EPROTO;
    return -1;
  }
  request->opcode = read_u16(header + 6U);
  request->request_id = read_u64(header + 8U);
  request->handle_id = read_u32(header + 16U);
  request->flags = read_u32(header + 20U);
  request->payload_length = read_u32(header + 24U);
  request->payload = NULL;
  if (request->request_id == 0U || request->payload_length > LGFS_MAX_PAYLOAD) {
    errno = EPROTO;
    return -1;
  }
  if (request->payload_length > 0U) {
    request->payload = malloc(request->payload_length);
    if (request->payload == NULL) return -1;
    if (read_all(STDIN_FILENO, request->payload, request->payload_length, 0) != 0) {
      free(request->payload);
      request->payload = NULL;
      return -1;
    }
  }
  return 0;
}

static int send_response(const struct lgfs_response *response) {
  uint8_t header[LGFS_HEADER_SIZE];
  memset(header, 0, sizeof(header));
  write_u32(header, LGFS_MAGIC);
  write_u16(header + 4U, LGFS_VERSION);
  write_u16(header + 6U, (uint16_t)(response->opcode | LGFS_RESPONSE_BIT));
  write_u64(header + 8U, response->request_id);
  write_u32(header + 16U, response->status);
  write_u32(header + 20U, (uint32_t)response->error_number);
  write_u32(header + 24U, response->handle_id);
  write_u32(header + 28U, response->payload_length);
  if (write_all(STDOUT_FILENO, header, sizeof(header)) < 0) return -1;
  if (response->payload_length > 0U &&
      write_all(STDOUT_FILENO, response->payload, response->payload_length) < 0) {
    return -1;
  }
  return 0;
}

static void handle_open_root(const struct lgfs_request *request, struct lgfs_response *response) {
  if (request->handle_id != 0U || request->flags != 0U || request->payload_length < 2U ||
      request->payload_length >= PATH_MAX || request->payload[0] != '/' ||
      memchr(request->payload, 0, request->payload_length) != NULL) {
    response_error(response, LGFS_STATUS_INVALID, EINVAL);
    return;
  }
  char path[PATH_MAX];
  memcpy(path, request->payload, request->payload_length);
  path[request->payload_length] = '\0';
  int fd = open(path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (fd < 0) {
    response_error(response, LGFS_STATUS_SYSTEM, errno);
    return;
  }
  struct stat metadata;
  char observed_path[PATH_MAX];
  int validation_errno = 0;
  if (fstat(fd, &metadata) < 0) {
    validation_errno = errno;
  } else if (!S_ISDIR(metadata.st_mode)) {
    validation_errno = ENOTDIR;
  } else if (fd_path(fd, observed_path) < 0) {
    validation_errno = errno;
  } else if (strcmp(path, observed_path) != 0) {
    validation_errno = ESTALE;
  }
  if (validation_errno != 0) {
    (void)close(fd);
    response_error(response, LGFS_STATUS_IDENTITY, validation_errno);
    return;
  }
  uint32_t id = add_handle(fd, 0, 0U, NULL);
  if (id == 0U) {
    int saved_errno = errno;
    (void)close(fd);
    response_error(response, LGFS_STATUS_LIMIT, saved_errno);
    return;
  }
  response->handle_id = id;
  if (allocate_path_payload(fd, &response->payload, &response->payload_length) < 0) {
    int saved_errno = errno;
    (void)close(fd);
    handles[id].active = 0;
    response->handle_id = 0U;
    response_error(response, LGFS_STATUS_SYSTEM, saved_errno);
  }
}

static void handle_open_child(const struct lgfs_request *request, struct lgfs_response *response,
                              int create_mode) {
  char component[LGFS_MAX_COMPONENT + 1U];
  if (request->flags != 0U ||
      component_string(request->payload, request->payload_length, component) < 0) {
    response_error(response, LGFS_STATUS_INVALID, EINVAL);
    return;
  }
  struct lgfs_handle *parent = selected_handle(request->handle_id);
  if (parent == NULL) {
    response_error(response, LGFS_STATUS_IDENTITY, EBADF);
    return;
  }
  if (validate_handle_recursive(request->handle_id, 0U) < 0) {
    response_error(response, LGFS_STATUS_IDENTITY, errno);
    return;
  }
  if (create_mode != 0) {
    if (test_barrier(LGFS_TEST_BEFORE_CREATE_CHILD) < 0) {
      response_error(response, LGFS_STATUS_SYSTEM, errno);
      return;
    }
    if (mkdirat(parent->fd, component, 0700) < 0) {
      if (!(create_mode == 1 && errno == EEXIST)) {
        response_error(response, LGFS_STATUS_SYSTEM, errno);
        return;
      }
    }
    if (test_barrier(LGFS_TEST_AFTER_MKDIR_BEFORE_OPEN) < 0) {
      response_error(response, LGFS_STATUS_SYSTEM, errno);
      return;
    }
  }
  int fd = open_directory_at(parent->fd, component);
  if (fd < 0) {
    response_error(response, LGFS_STATUS_SYSTEM, errno);
    return;
  }
  struct stat metadata;
  char child_path[PATH_MAX];
  if (fstat(fd, &metadata) < 0) {
    int saved_errno = errno;
    (void)close(fd);
    response_error(response, LGFS_STATUS_SYSTEM, saved_errno);
    return;
  }
  if (!S_ISDIR(metadata.st_mode)) {
    (void)close(fd);
    response_error(response, LGFS_STATUS_WRONG_TYPE, ENOTDIR);
    return;
  }
  if (metadata.st_uid != geteuid() || (metadata.st_mode & 0077U) != 0U) {
    (void)close(fd);
    response_error(response, LGFS_STATUS_PERMISSIONS, EACCES);
    return;
  }
  if (expected_child_path(parent->fd, component, fd, child_path) < 0) {
    int saved_errno = errno == 0 ? ESTALE : errno;
    (void)close(fd);
    response_error(response, LGFS_STATUS_IDENTITY, saved_errno);
    return;
  }
  if (validate_handle_recursive(request->handle_id, 0U) < 0) {
    int saved_errno = errno;
    (void)close(fd);
    response_error(response, LGFS_STATUS_IDENTITY, saved_errno);
    return;
  }
  uint32_t id = add_handle(fd, 1, request->handle_id, component);
  if (id == 0U) {
    int saved_errno = errno;
    (void)close(fd);
    response_error(response, LGFS_STATUS_LIMIT, saved_errno);
    return;
  }
  response->handle_id = id;
  size_t path_length = strlen(child_path);
  response->payload = malloc(path_length);
  if (response->payload == NULL) {
    int saved_errno = errno;
    (void)close(fd);
    handles[id].active = 0;
    response->handle_id = 0U;
    response_error(response, LGFS_STATUS_SYSTEM, saved_errno);
    return;
  }
  memcpy(response->payload, child_path, path_length);
  response->payload_length = (uint32_t)path_length;
}

static int file_times_equal(const struct stat *left, const struct stat *right) {
#if defined(__APPLE__)
  return left->st_ctimespec.tv_sec == right->st_ctimespec.tv_sec &&
         left->st_ctimespec.tv_nsec == right->st_ctimespec.tv_nsec &&
         left->st_mtimespec.tv_sec == right->st_mtimespec.tv_sec &&
         left->st_mtimespec.tv_nsec == right->st_mtimespec.tv_nsec;
#else
  return left->st_ctim.tv_sec == right->st_ctim.tv_sec &&
         left->st_ctim.tv_nsec == right->st_ctim.tv_nsec &&
         left->st_mtim.tv_sec == right->st_mtim.tv_sec &&
         left->st_mtim.tv_nsec == right->st_mtim.tv_nsec;
#endif
}

static int verified_entry_identity(int directory_fd, const char *component,
                                   const struct stat *expected, mode_t expected_permissions) {
  int fd = openat(directory_fd, component, O_RDONLY | O_NONBLOCK | O_NOFOLLOW | O_CLOEXEC);
  if (fd < 0) return -1;
  struct stat observed;
  int result = fstat(fd, &observed);
  int saved_errno = errno;
  if (close(fd) < 0 && result == 0) {
    result = -1;
    saved_errno = errno;
  }
  if (result < 0) {
    errno = saved_errno;
    return -1;
  }
  if (!private_file_metadata(&observed) || !same_identity(expected, &observed) ||
      (observed.st_mode & 0777U) != expected_permissions) {
    errno = ESTALE;
    return -1;
  }
  return 0;
}

static int remove_file_if_owned(int directory_fd, const char *component,
                                const struct stat *expected) {
  struct stat observed;
  if (fstatat(directory_fd, component, &observed, AT_SYMLINK_NOFOLLOW) < 0) {
    if (errno == ENOENT) return 0;
    return -1;
  }
  if (!same_identity(expected, &observed)) {
    errno = ESTALE;
    return -1;
  }
  return unlinkat(directory_fd, component, 0);
}

static int verified_publication_pair(int directory_fd, const char *temporary, const char *final,
                                     const struct stat *expected,
                                     mode_t expected_permissions) {
  struct stat temporary_entry;
  struct stat final_entry;
  if (fstatat(directory_fd, temporary, &temporary_entry, AT_SYMLINK_NOFOLLOW) < 0) return -1;
  if (fstatat(directory_fd, final, &final_entry, AT_SYMLINK_NOFOLLOW) < 0) return -1;
  if (!private_file_metadata(&temporary_entry) || !private_file_metadata(&final_entry) ||
      !same_identity(expected, &temporary_entry) ||
      !same_identity(&temporary_entry, &final_entry) || temporary_entry.st_nlink != 2 ||
      final_entry.st_nlink != 2 ||
      (temporary_entry.st_mode & 0777U) != expected_permissions ||
      (final_entry.st_mode & 0777U) != expected_permissions) {
    errno = ESTALE;
    return -1;
  }
  return 0;
}

static void handle_write_file(const struct lgfs_request *request, struct lgfs_response *response) {
  if ((request->flags & ~LGFS_WRITE_READ_ONLY) != 0U || request->payload_length < 8U) {
    response_error(response, LGFS_STATUS_INVALID, EINVAL);
    return;
  }
  uint16_t temporary_length = read_u16(request->payload);
  uint16_t final_length = read_u16(request->payload + 2U);
  uint32_t data_length = read_u32(request->payload + 4U);
  uint64_t expected_length = 8ULL + temporary_length + final_length + data_length;
  if (expected_length != request->payload_length || data_length > LGFS_MAX_PAYLOAD) {
    response_error(response, LGFS_STATUS_INVALID, EINVAL);
    return;
  }
  char temporary[LGFS_MAX_COMPONENT + 1U];
  char final[LGFS_MAX_COMPONENT + 1U];
  if (component_string(request->payload + 8U, temporary_length, temporary) < 0 ||
      component_string(request->payload + 8U + temporary_length, final_length, final) < 0) {
    response_error(response, LGFS_STATUS_INVALID, EINVAL);
    return;
  }
  struct lgfs_handle *directory = selected_handle(request->handle_id);
  if (directory == NULL) {
    response_error(response, LGFS_STATUS_IDENTITY, EBADF);
    return;
  }
  if (validate_handle_recursive(request->handle_id, 0U) < 0) {
    response_error(response, LGFS_STATUS_IDENTITY, errno);
    return;
  }
  const uint8_t *bytes = request->payload + 8U + temporary_length + final_length;
  int fd = openat(directory->fd, temporary,
                  O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600);
  if (fd < 0) {
    response_error(response, LGFS_STATUS_SYSTEM, errno);
    return;
  }
  struct stat created;
  int have_identity = 0;
  int final_linked = 0;
  int primary_errno = 0;
  uint32_t primary_status = LGFS_STATUS_SYSTEM;
  mode_t published_permissions = (request->flags & LGFS_WRITE_READ_ONLY) != 0U ? 0400U : 0600U;
  if (fchmod(fd, 0600) < 0) {
    primary_errno = errno;
  } else if (fstat(fd, &created) < 0) {
    primary_errno = errno;
  } else if (!private_file_metadata(&created) || created.st_nlink != 1) {
    primary_errno = ESTALE;
    primary_status = LGFS_STATUS_IDENTITY;
  } else {
    have_identity = 1;
  }
  if (primary_errno == 0 && write_all(fd, bytes, data_length) < 0) primary_errno = errno;
  if (primary_errno == 0 && fsync(fd) < 0) primary_errno = errno;
  if (primary_errno == 0 && (request->flags & LGFS_WRITE_READ_ONLY) != 0U) {
    if (fchmod(fd, 0400) < 0 || fsync(fd) < 0) primary_errno = errno;
  }
  if (close(fd) < 0 && primary_errno == 0) primary_errno = errno;
  if (primary_errno == 0 &&
      verified_entry_identity(directory->fd, temporary, &created, published_permissions) < 0) {
    primary_errno = errno;
    primary_status = LGFS_STATUS_IDENTITY;
  }
  if (primary_errno == 0 && validate_handle_recursive(request->handle_id, 0U) < 0) {
    primary_errno = errno;
    primary_status = LGFS_STATUS_IDENTITY;
  }
  if (primary_errno == 0 &&
      test_barrier(LGFS_TEST_AFTER_TEMP_FSYNC_BEFORE_LINK) < 0) {
    primary_errno = errno;
  }
  if (primary_errno == 0) {
    if (linkat(directory->fd, temporary, directory->fd, final, 0) < 0) {
      primary_errno = errno;
    } else {
      final_linked = 1;
    }
  }
  if (primary_errno == 0 &&
      verified_entry_identity(directory->fd, final, &created, published_permissions) < 0) {
    primary_errno = errno;
    primary_status = LGFS_STATUS_IDENTITY;
  }
  if (primary_errno == 0 && fsync(directory->fd) < 0) primary_errno = errno;
  if (primary_errno == 0 &&
      test_barrier(LGFS_TEST_AFTER_LINK_BEFORE_TEMP_UNLINK) < 0) {
    primary_errno = errno;
  }
  if (primary_errno == 0 &&
      verified_publication_pair(directory->fd, temporary, final, &created,
                                published_permissions) < 0) {
    primary_errno = errno;
    primary_status = LGFS_STATUS_IDENTITY;
  }
  if (primary_errno == 0 && validate_handle_recursive(request->handle_id, 0U) < 0) {
    primary_errno = errno;
    primary_status = LGFS_STATUS_IDENTITY;
  }
  if (primary_errno == 0 && remove_file_if_owned(directory->fd, temporary, &created) < 0) {
    primary_errno = errno;
    primary_status = LGFS_STATUS_IDENTITY;
  }
  if (primary_errno != 0) {
    int cleanup_errno = 0;
    if (final_linked && have_identity &&
        verified_publication_pair(directory->fd, temporary, final, &created,
                                  published_permissions) == 0) {
      if (remove_file_if_owned(directory->fd, final, &created) < 0 ||
          fsync(directory->fd) < 0) {
        cleanup_errno = errno;
      } else {
        final_linked = 0;
      }
    }
    if (!final_linked && have_identity &&
        remove_file_if_owned(directory->fd, temporary, &created) < 0) {
      cleanup_errno = errno;
    }
    response_error(response, cleanup_errno == 0 ? primary_status : LGFS_STATUS_IDENTITY,
                   cleanup_errno == 0 ? primary_errno : cleanup_errno);
  }
}

static int monotonic_milliseconds(uint64_t *value) {
  struct timespec observed;
  if (clock_gettime(CLOCK_MONOTONIC, &observed) < 0) return -1;
  *value = (uint64_t)observed.tv_sec * 1000U + (uint64_t)observed.tv_nsec / 1000000U;
  return 0;
}

static int wait_for_single_link(int fd, const struct stat *first, uint32_t timeout_ms,
                                struct stat *stable) {
  uint64_t started = 0U;
  if (monotonic_milliseconds(&started) < 0) return -1;
  for (;;) {
    if (fstat(fd, stable) < 0) return -1;
    if (!private_file_metadata(stable) || !same_identity(first, stable) ||
        stable->st_size != first->st_size) {
      errno = ESTALE;
      return -1;
    }
    if (stable->st_nlink == 1) return 0;
    if (stable->st_nlink < 1 || stable->st_nlink > 2) {
      errno = ESTALE;
      return -1;
    }
    uint64_t now = 0U;
    if (monotonic_milliseconds(&now) < 0) return -1;
    if (now - started >= timeout_ms) {
      errno = ETIMEDOUT;
      return 1;
    }
    struct timespec pause = {.tv_sec = 0, .tv_nsec = 1000000L};
    while (nanosleep(&pause, &pause) < 0 && errno == EINTR) {
    }
  }
}

static void handle_read_file(const struct lgfs_request *request, struct lgfs_response *response) {
  if (request->flags != 0U || request->payload_length < 10U) {
    response_error(response, LGFS_STATUS_INVALID, EINVAL);
    return;
  }
  uint16_t component_length = read_u16(request->payload);
  uint32_t maximum_bytes = read_u32(request->payload + 2U);
  uint32_t stabilization_ms = read_u32(request->payload + 6U);
  if ((uint32_t)component_length + 10U != request->payload_length || maximum_bytes == 0U ||
      maximum_bytes > LGFS_MAX_PAYLOAD || stabilization_ms == 0U ||
      stabilization_ms > LGFS_MAX_STABILIZATION_MS) {
    response_error(response, LGFS_STATUS_INVALID, EINVAL);
    return;
  }
  char component[LGFS_MAX_COMPONENT + 1U];
  if (component_string(request->payload + 10U, component_length, component) < 0) {
    response_error(response, LGFS_STATUS_INVALID, EINVAL);
    return;
  }
  struct lgfs_handle *directory = selected_handle(request->handle_id);
  if (directory == NULL) {
    response_error(response, LGFS_STATUS_IDENTITY, EBADF);
    return;
  }
  if (validate_handle_recursive(request->handle_id, 0U) < 0) {
    response_error(response, LGFS_STATUS_IDENTITY, errno);
    return;
  }
  if (test_barrier(LGFS_TEST_BEFORE_OPEN_FINAL) < 0) {
    response_error(response, LGFS_STATUS_SYSTEM, errno);
    return;
  }
  int fd = openat(directory->fd, component, O_RDONLY | O_NONBLOCK | O_NOFOLLOW | O_CLOEXEC);
  if (fd < 0) {
    response_error(response, LGFS_STATUS_SYSTEM, errno);
    return;
  }
  struct stat first;
  struct stat before;
  int primary_errno = 0;
  uint32_t primary_status = LGFS_STATUS_SYSTEM;
  if (fstat(fd, &first) < 0) {
    primary_errno = errno;
  } else if (!S_ISREG(first.st_mode)) {
    primary_errno = EISDIR;
    primary_status = LGFS_STATUS_WRONG_TYPE;
  } else if (first.st_uid != geteuid() || (first.st_mode & 0077U) != 0U) {
    primary_errno = EACCES;
    primary_status = LGFS_STATUS_PERMISSIONS;
  }
  if (primary_errno == 0 && test_barrier(LGFS_TEST_AFTER_OPEN_FINAL) < 0) {
    primary_errno = errno;
  }
  int stable_result = 0;
  if (primary_errno == 0) {
    stable_result = wait_for_single_link(fd, &first, stabilization_ms, &before);
    if (stable_result < 0) {
      primary_errno = errno;
      primary_status = LGFS_STATUS_IDENTITY;
    } else if (stable_result > 0) {
      primary_errno = errno;
      primary_status = LGFS_STATUS_INCOMPLETE;
    }
  }
  if (primary_errno == 0 &&
      (before.st_size < 0 || (uint64_t)before.st_size > maximum_bytes)) {
    primary_errno = EFBIG;
    primary_status = LGFS_STATUS_LIMIT;
  }
  uint8_t *bytes = NULL;
  uint32_t length = 0U;
  if (primary_errno == 0) {
    length = (uint32_t)before.st_size;
    bytes = malloc(length == 0U ? 1U : length);
    if (bytes == NULL) primary_errno = errno;
  }
  size_t offset = 0U;
  while (primary_errno == 0 && offset < length) {
    ssize_t observed = pread(fd, bytes + offset, length - offset, (off_t)offset);
    if (observed < 0) {
      if (errno == EINTR) continue;
      primary_errno = errno;
      break;
    }
    if (observed == 0) {
      primary_errno = EIO;
      break;
    }
    offset += (size_t)observed;
  }
  struct stat after;
  if (primary_errno == 0 && fstat(fd, &after) < 0) primary_errno = errno;
  if (primary_errno == 0 &&
      (!private_file_metadata(&after) || !same_identity(&before, &after) ||
       before.st_size != after.st_size || after.st_nlink != 1 ||
       !file_times_equal(&before, &after))) {
    primary_errno = ESTALE;
    primary_status = LGFS_STATUS_IDENTITY;
  }
  if (close(fd) < 0 && primary_errno == 0) primary_errno = errno;
  if (primary_errno == 0 && validate_handle_recursive(request->handle_id, 0U) < 0) {
    primary_errno = errno;
    primary_status = LGFS_STATUS_IDENTITY;
  }
  if (primary_errno == 0 &&
      verified_entry_identity(directory->fd, component, &after, after.st_mode & 0777U) < 0) {
    primary_errno = errno;
    primary_status = LGFS_STATUS_IDENTITY;
  }
  if (primary_errno != 0) {
    free(bytes);
    response_error(response, primary_status, primary_errno);
    return;
  }
  response->payload = bytes;
  response->payload_length = length;
}

static int remove_directory_contents(int directory_fd, uint32_t depth) {
  if (depth > 128U) {
    errno = ELOOP;
    return -1;
  }
  int duplicate = dup(directory_fd);
  if (duplicate < 0) return -1;
  DIR *stream = fdopendir(duplicate);
  if (stream == NULL) {
    int saved_errno = errno;
    (void)close(duplicate);
    errno = saved_errno;
    return -1;
  }
  int result = 0;
  int saved_errno = 0;
  for (;;) {
    errno = 0;
    struct dirent *entry = readdir(stream);
    if (entry == NULL) {
      if (errno != 0) {
        result = -1;
        saved_errno = errno;
      }
      break;
    }
    if (strcmp(entry->d_name, ".") == 0 || strcmp(entry->d_name, "..") == 0) continue;
    size_t length = strlen(entry->d_name);
    if (!valid_component_bytes((const uint8_t *)entry->d_name, (uint32_t)length)) {
      result = -1;
      saved_errno = EINVAL;
      break;
    }
    struct stat before;
    if (fstatat(directory_fd, entry->d_name, &before, AT_SYMLINK_NOFOLLOW) < 0) {
      result = -1;
      saved_errno = errno;
      break;
    }
    if (S_ISDIR(before.st_mode)) {
      int child = open_directory_at(directory_fd, entry->d_name);
      if (child < 0) {
        result = -1;
        saved_errno = errno;
        break;
      }
      struct stat opened;
      if (fstat(child, &opened) < 0) {
        result = -1;
        saved_errno = errno;
        (void)close(child);
        break;
      }
      if (!same_identity(&before, &opened)) {
        result = -1;
        saved_errno = ESTALE;
        (void)close(child);
        break;
      }
      if (remove_directory_contents(child, depth + 1U) < 0) {
        result = -1;
        saved_errno = errno;
        (void)close(child);
        break;
      }
      if (close(child) < 0) {
        result = -1;
        saved_errno = errno;
        break;
      }
      struct stat final;
      if (fstatat(directory_fd, entry->d_name, &final, AT_SYMLINK_NOFOLLOW) < 0) {
        result = -1;
        saved_errno = errno;
        break;
      }
      if (!same_identity(&before, &final)) {
        result = -1;
        saved_errno = ESTALE;
        break;
      }
      if (unlinkat(directory_fd, entry->d_name, AT_REMOVEDIR) < 0) {
        result = -1;
        saved_errno = errno;
        break;
      }
    } else {
      if (unlinkat(directory_fd, entry->d_name, 0) < 0) {
        result = -1;
        saved_errno = errno;
        break;
      }
    }
  }
  if (closedir(stream) < 0 && result == 0) {
    result = -1;
    saved_errno = errno;
  }
  if (result < 0) errno = saved_errno;
  return result;
}

static int rename_noreplace_at(int old_directory, const char *old_name, int new_directory,
                               const char *new_name) {
#if defined(__APPLE__)
  return renameatx_np(old_directory, old_name, new_directory, new_name, RENAME_EXCL);
#elif defined(__linux__) && defined(SYS_renameat2)
  return (int)syscall(SYS_renameat2, old_directory, old_name, new_directory, new_name,
                      (unsigned int)RENAME_NOREPLACE);
#else
  (void)old_directory;
  (void)old_name;
  (void)new_directory;
  (void)new_name;
  errno = ENOTSUP;
  return -1;
#endif
}

static int remove_tree_parent_fsync(int fd) {
#if defined(LGFS_TEST_REMOVE_TREE_PARENT_FSYNC_FAILURE)
  (void)fd;
  errno = EIO;
  return -1;
#else
  return fsync(fd);
#endif
}

static int remove_tree_close(int fd) {
#if defined(LGFS_TEST_REMOVE_TREE_CLOSE_FAILURE)
  if (close(fd) < 0) return -1;
  errno = EIO;
  return -1;
#else
  return close(fd);
#endif
}

static int protocol_handle_close(int fd) {
#if defined(LGFS_TEST_CLOSE_HANDLE_FAILURE)
  static int fired = 0;
  if (!fired) {
    fired = 1;
    if (close(fd) < 0) return -1;
    errno = EIO;
    return -1;
  }
#endif
  return close(fd);
}

static void consume_remove_tree_handle(struct lgfs_handle *directory, int *primary_errno) {
  int fd = directory->fd;
  directory->active = 0;
  directory->fd = -1;
  if (remove_tree_close(fd) < 0 && *primary_errno == 0) *primary_errno = errno;
}

static int restore_quarantined_directory(struct lgfs_handle *parent,
                                         const struct lgfs_handle *directory,
                                         const char *quarantine) {
#if defined(LGFS_TEST_REMOVE_TREE_RESTORE_FAILURE)
  (void)parent;
  (void)directory;
  (void)quarantine;
  errno = EIO;
  return -1;
#else
  struct stat original;
  if (fstatat(parent->fd, directory->name, &original, AT_SYMLINK_NOFOLLOW) == 0) {
    if (original.st_dev != directory->device || original.st_ino != directory->inode) {
      errno = EEXIST;
      return -1;
    }
    return fsync(parent->fd);
  }
  if (errno != ENOENT) return -1;

  struct stat quarantined;
  if (fstatat(parent->fd, quarantine, &quarantined, AT_SYMLINK_NOFOLLOW) < 0) return -1;
  if (quarantined.st_dev != directory->device || quarantined.st_ino != directory->inode) {
    errno = ESTALE;
    return -1;
  }
  if (rename_noreplace_at(parent->fd, quarantine, parent->fd, directory->name) < 0) return -1;
  if (fstatat(parent->fd, directory->name, &original, AT_SYMLINK_NOFOLLOW) < 0) return -1;
  if (original.st_dev != directory->device || original.st_ino != directory->inode) {
    errno = ESTALE;
    return -1;
  }
  return fsync(parent->fd);
#endif
}

static void handle_remove_tree(const struct lgfs_request *request, struct lgfs_response *response) {
  char quarantine[LGFS_MAX_COMPONENT + 1U];
  if (request->flags != 0U ||
      component_string(request->payload, request->payload_length, quarantine) < 0) {
    response_error(response, LGFS_STATUS_INVALID, EINVAL);
    return;
  }
  struct lgfs_handle *directory = selected_handle(request->handle_id);
  if (directory == NULL) {
    response_error(response, LGFS_STATUS_IDENTITY, EBADF);
    return;
  }
  if (directory->parent_id == 0U || active_child_exists(request->handle_id)) {
    response_error(response, LGFS_STATUS_IDENTITY, EBUSY);
    return;
  }
  if (validate_handle_recursive(request->handle_id, 0U) < 0) {
    response_error(response, LGFS_STATUS_IDENTITY, errno);
    return;
  }
  struct lgfs_handle *parent = parent_handle(directory);
  if (parent == NULL) {
    response_error(response, LGFS_STATUS_IDENTITY, errno);
    return;
  }
  if (test_barrier(LGFS_TEST_BEFORE_CLEANUP_RENAME) < 0) {
    response_error(response, LGFS_STATUS_SYSTEM, errno);
    return;
  }
  if (rename_noreplace_at(parent->fd, directory->name, parent->fd, quarantine) < 0) {
    response_error(response, LGFS_STATUS_SYSTEM, errno);
    return;
  }

  int primary_errno = 0;
  uint32_t primary_status = LGFS_STATUS_SYSTEM;
  if (test_barrier(LGFS_TEST_AFTER_CLEANUP_RENAME_BEFORE_IDENTITY_CHECK) < 0) {
    primary_errno = errno;
  }
#if defined(LGFS_TEST_REMOVE_TREE_PRECOMMIT_FAILURE)
  if (primary_errno == 0) primary_errno = EIO;
#endif
  struct stat observed;
  if (primary_errno == 0 &&
      fstatat(parent->fd, quarantine, &observed, AT_SYMLINK_NOFOLLOW) < 0) {
    primary_errno = errno;
  } else if (primary_errno == 0 &&
             (observed.st_dev != directory->device || observed.st_ino != directory->inode)) {
    primary_errno = ESTALE;
    primary_status = LGFS_STATUS_IDENTITY;
  }
  if (primary_errno == 0 && remove_directory_contents(directory->fd, 0U) < 0) {
    primary_errno = errno;
  }
  if (primary_errno == 0 && fsync(directory->fd) < 0) primary_errno = errno;
  if (primary_errno == 0 && test_barrier(LGFS_TEST_BEFORE_CLEANUP_UNLINK) < 0) {
    primary_errno = errno;
  }
  if (primary_errno == 0 &&
      fstatat(parent->fd, quarantine, &observed, AT_SYMLINK_NOFOLLOW) < 0) {
    primary_errno = errno;
  } else if (primary_errno == 0 &&
             (observed.st_dev != directory->device || observed.st_ino != directory->inode)) {
    primary_errno = ESTALE;
    primary_status = LGFS_STATUS_IDENTITY;
  }

  if (primary_errno == 0 && unlinkat(parent->fd, quarantine, AT_REMOVEDIR) == 0) {
    int completion_errno = 0;
    directory->active = 0;
    int removed_fd = directory->fd;
    directory->fd = -1;
    if (remove_tree_parent_fsync(parent->fd) < 0) completion_errno = errno;
    if (remove_tree_close(removed_fd) < 0 && completion_errno == 0) completion_errno = errno;
    if (completion_errno != 0) {
      response_error(response, LGFS_STATUS_INCOMPLETE, completion_errno);
    }
    return;
  }
  if (primary_errno == 0) primary_errno = errno;

  int saved_errno = primary_errno;
  if (restore_quarantined_directory(parent, directory, quarantine) == 0) {
    response_error(response, primary_status, saved_errno);
    return;
  }

  int consume_errno = saved_errno;
  consume_remove_tree_handle(directory, &consume_errno);
  response_error(response, LGFS_STATUS_INCOMPLETE, consume_errno);
}

#if defined(__APPLE__)
static int darwin_start_microseconds(uint64_t seconds, uint64_t microseconds, uint64_t *result) {
  if (microseconds > UINT64_C(999999) ||
      seconds > (UINT64_MAX - microseconds) / UINT64_C(1000000)) {
    errno = EOVERFLOW;
    return -1;
  }
  *result = seconds * UINT64_C(1000000) + microseconds;
  return 0;
}
#endif

static void handle_read_process_identity(const struct lgfs_request *request,
                                         struct lgfs_response *response) {
  if (request->handle_id != 0U || request->flags != 0U || request->payload_length != 4U) {
    response_error(response, LGFS_STATUS_INVALID, EINVAL);
    return;
  }
#if defined(__APPLE__)
  uint32_t requested_pid = read_u32(request->payload);
  if (requested_pid == 0U || requested_pid > (uint32_t)INT_MAX) {
    response_error(response, LGFS_STATUS_INVALID, EINVAL);
    return;
  }
  struct proc_bsdinfo first;
  struct proc_bsdinfo second;
  memset(&first, 0, sizeof(first));
  memset(&second, 0, sizeof(second));
  errno = 0;
  int first_bytes =
      proc_pidinfo((int)requested_pid, PROC_PIDTBSDINFO, 0U, &first, sizeof(first));
  if (first_bytes != (int)sizeof(first)) {
    response_error(response, LGFS_STATUS_SYSTEM, errno == 0 ? ESRCH : errno);
    return;
  }
  errno = 0;
  int second_bytes =
      proc_pidinfo((int)requested_pid, PROC_PIDTBSDINFO, 0U, &second, sizeof(second));
  if (second_bytes != (int)sizeof(second)) {
    response_error(response, LGFS_STATUS_SYSTEM, errno == 0 ? ESRCH : errno);
    return;
  }
  if (first.pbi_pid != requested_pid || second.pbi_pid != requested_pid ||
      first.pbi_status == SZOMB || second.pbi_status == SZOMB || first.pbi_pgid == 0U ||
      second.pbi_pgid == 0U || first.pbi_pid != second.pbi_pid ||
      first.pbi_ppid != second.pbi_ppid || first.pbi_pgid != second.pbi_pgid ||
      first.pbi_ruid != second.pbi_ruid || first.pbi_start_tvsec != second.pbi_start_tvsec ||
      first.pbi_start_tvusec != second.pbi_start_tvusec) {
    response_error(response, LGFS_STATUS_IDENTITY, ESTALE);
    return;
  }
  uint64_t start_microseconds = 0U;
  if (darwin_start_microseconds(second.pbi_start_tvsec, second.pbi_start_tvusec,
                                &start_microseconds) < 0) {
    response_error(response, LGFS_STATUS_IDENTITY, errno);
    return;
  }
  uint8_t *payload = malloc(24U);
  if (payload == NULL) {
    response_error(response, LGFS_STATUS_SYSTEM, errno);
    return;
  }
  write_u32(payload, second.pbi_pid);
  write_u32(payload + 4U, second.pbi_ppid);
  write_u32(payload + 8U, second.pbi_pgid);
  write_u32(payload + 12U, second.pbi_ruid);
  write_u64(payload + 16U, start_microseconds);
  response->payload = payload;
  response->payload_length = 24U;
#else
  response_error(response, LGFS_STATUS_INVALID, ENOTSUP);
#endif
}

static void dispatch_request(const struct lgfs_request *request, struct lgfs_response *response,
                             int *shutdown) {
  response->opcode = request->opcode;
  response->request_id = request->request_id;
  switch (request->opcode) {
    case LGFS_OPEN_ROOT:
      handle_open_root(request, response);
      return;
    case LGFS_ENSURE_PRIVATE_CHILD:
      handle_open_child(request, response, 1);
      return;
    case LGFS_CREATE_PRIVATE_CHILD:
      handle_open_child(request, response, 2);
      return;
    case LGFS_OPEN_PRIVATE_CHILD:
      handle_open_child(request, response, 0);
      return;
    case LGFS_VERIFY_DIRECTORY:
      if (request->flags != 0U || request->payload_length != 0U) {
        response_error(response, LGFS_STATUS_INVALID, EINVAL);
      } else if (selected_handle(request->handle_id) == NULL) {
        response_error(response, LGFS_STATUS_IDENTITY, EBADF);
      } else if (validate_handle_recursive(request->handle_id, 0U) < 0) {
        response_error(response, LGFS_STATUS_IDENTITY, errno);
      }
      return;
    case LGFS_WRITE_FILE:
      handle_write_file(request, response);
      return;
    case LGFS_READ_FILE:
      handle_read_file(request, response);
      return;
    case LGFS_REMOVE_TREE:
      handle_remove_tree(request, response);
      return;
    case LGFS_CLOSE_HANDLE: {
      if (request->flags != 0U || request->payload_length != 0U) {
        response_error(response, LGFS_STATUS_INVALID, EINVAL);
        return;
      }
      struct lgfs_handle *handle = selected_handle(request->handle_id);
      if (handle == NULL) {
        response_error(response, LGFS_STATUS_IDENTITY, EBADF);
        return;
      }
      if (active_child_exists(request->handle_id)) {
        response_error(response, LGFS_STATUS_IDENTITY, EBUSY);
        return;
      }
      int fd = handle->fd;
      handle->active = 0;
      handle->fd = -1;
      if (protocol_handle_close(fd) < 0) {
        response_error(response, LGFS_STATUS_INCOMPLETE, errno);
      }
      return;
    }
    case LGFS_SHUTDOWN:
      if (request->handle_id != 0U || request->flags != 0U || request->payload_length != 0U) {
        response_error(response, LGFS_STATUS_INVALID, EINVAL);
        return;
      }
      for (uint32_t id = 1U; id < next_handle_id; id += 1U) {
        if (handles[id].active) {
          response_error(response, LGFS_STATUS_INVALID, EBUSY);
          return;
        }
      }
      *shutdown = 1;
      return;
    case LGFS_READ_PROCESS_IDENTITY:
      handle_read_process_identity(request, response);
      return;
    default:
      response_error(response, LGFS_STATUS_INVALID, EINVAL);
      return;
  }
}

static int broker_main(void) {
  int shutdown = 0;
  while (!shutdown) {
    struct lgfs_request request;
    memset(&request, 0, sizeof(request));
    int parsed = parse_request(&request);
    if (parsed == 1) break;
    if (parsed < 0) {
      close_all_handles();
      return 70;
    }
    struct lgfs_response response;
    memset(&response, 0, sizeof(response));
    dispatch_request(&request, &response, &shutdown);
    free(request.payload);
    if (send_response(&response) < 0) {
      free(response.payload);
      close_all_handles();
      return 71;
    }
    free(response.payload);
  }
  close_all_handles();
  return 0;
}

static int self_test(void) {
  uint8_t encoded[8];
  write_u64(encoded, UINT64_C(0x0102030405060708));
  if (read_u64(encoded) != UINT64_C(0x0102030405060708)) return 1;
  const uint8_t component[] = "safe-component";
  if (!valid_component_bytes(component, (uint32_t)(sizeof(component) - 1U))) return 2;
  const uint8_t unsafe[] = "../unsafe";
  if (valid_component_bytes(unsafe, (uint32_t)(sizeof(unsafe) - 1U))) return 3;
  if (portable_error_code(ENOENT) != LGFS_ERROR_NO_ENTRY ||
      portable_error_code(EEXIST) != LGFS_ERROR_EXISTS ||
      portable_error_code(ESTALE) != LGFS_ERROR_STALE) {
    return 4;
  }
#if defined(__APPLE__)
  uint64_t first_start = 0U;
  uint64_t second_start = 0U;
  if (darwin_start_microseconds(UINT64_C(100), UINT64_C(1), &first_start) < 0 ||
      darwin_start_microseconds(UINT64_C(100), UINT64_C(2), &second_start) < 0 ||
      first_start != UINT64_C(100000001) || second_start != UINT64_C(100000002) ||
      first_start == second_start) {
    return 5;
  }
#endif
  puts("go-like_e2e_posix_filesystem self-test: PASS");
  return 0;
}

int main(int argc, char **argv) {
  if (argc == 2 && strcmp(argv[1], "--self-test") == 0) return self_test();
  if (argc == 2 && strcmp(argv[1], "--broker") == 0) return broker_main();
  return 64;
}
