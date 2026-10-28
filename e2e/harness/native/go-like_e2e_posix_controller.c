#if defined(__linux__)
#ifndef _GNU_SOURCE
#define _GNU_SOURCE
#endif
#elif defined(__APPLE__)
#ifndef _DARWIN_C_SOURCE
#define _DARWIN_C_SOURCE
#endif
#endif
#ifndef _POSIX_C_SOURCE
#define _POSIX_C_SOURCE 200809L
#endif

#include "go-like_e2e_posix_protocol.h"

#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <poll.h>
#include <signal.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/resource.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

#if defined(__APPLE__)
#include <libproc.h>
#include <sys/proc.h>
#elif defined(__linux__)
#include <sys/prctl.h>
#include <sys/random.h>
#include <sys/syscall.h>
#else
#error "go-like_e2e_posix_controller supports only macOS and Linux"
#endif

#ifndef PATH_MAX
#define PATH_MAX 4096
#endif

#define GO_LIKE_E2E_CONTROL_FD STDIN_FILENO
#define GO_LIKE_E2E_RESPONSE_FD 3
#define GO_LIKE_E2E_TARGET_STDOUT_FD 4
#define GO_LIKE_E2E_TARGET_STDERR_FD 5
#define GO_LIKE_E2E_INTERNAL_POLL_MS 25
#define GO_LIKE_E2E_MAX_TRACKED_PROCESSES 65536u
#define GO_LIKE_E2E_ERROR_MESSAGE_MAX 256u
#define GO_LIKE_E2E_CGROUP_NAME_MAX 96u
#define GO_LIKE_E2E_CGROUP_POPULATED_NA UINT32_MAX

#define ARRAY_LENGTH(value) (sizeof(value) / sizeof((value)[0]))

struct byte_buffer {
  uint8_t *data;
  size_t length;
  size_t capacity;
};

struct payload_reader {
  const uint8_t *data;
  size_t length;
  size_t offset;
};

struct request_frame {
  uint16_t type;
  uint32_t flags;
  uint64_t request_id;
  const uint8_t *nonce;
  const uint8_t *payload;
  size_t payload_length;
};

struct target_spec {
  char *cwd;
  char **argv;
  size_t argc;
  char **envp;
  size_t envc;
};

struct process_identity {
  pid_t pid;
  uint64_t start_identity;
};

struct process_record {
  pid_t pid;
  pid_t ppid;
  pid_t pgid;
  pid_t sid;
  uint64_t start_identity;
  bool zombie;
  bool owned;
};

struct process_snapshot {
  struct process_record *records;
  size_t count;
};

struct observation {
  uint32_t same_group_live;
  uint32_t breakaway_live;
};

struct target_status {
  bool known;
  uint32_t exit_kind;
  int32_t exit_value;
  uint32_t core_dumped;
};

enum anchor_command_kind {
  ANCHOR_COMMAND_START = 1,
  ANCHOR_COMMAND_EXIT = 2
};

struct anchor_command {
  uint32_t kind;
};

enum anchor_event_kind {
  ANCHOR_EVENT_READY = 1,
  ANCHOR_EVENT_TARGET_STARTED = 2,
  ANCHOR_EVENT_TARGET_EXIT = 3,
  ANCHOR_EVENT_ERROR = 4
};

struct anchor_event {
  uint32_t kind;
  int32_t value;
  uint32_t pid;
  uint32_t auxiliary;
};

#if defined(__linux__)
struct cgroup_mount {
  char mountpoint[PATH_MAX];
  char root[PATH_MAX];
};

struct cgroup_context {
  int parent_fd;
  int invocation_fd;
  int command_fd;
  int procs_fd;
  int kill_fd;
  int events_fd;
  char parent_realpath[PATH_MAX];
  char invocation_name[GO_LIKE_E2E_CGROUP_NAME_MAX];
  char command_name[GO_LIKE_E2E_CGROUP_NAME_MAX];
  char expected_identity[GO_LIKE_E2E_MAX_CGROUP_IDENTITY_BYTES];
  dev_t invocation_dev;
  ino_t invocation_ino;
  dev_t command_dev;
  ino_t command_ino;
  bool invocation_created;
  bool command_created;
};
#endif

enum cgroup_stage {
  CGROUP_STAGE_NOT_STARTED = 0,
  CGROUP_STAGE_OPEN_PARENT,
  CGROUP_STAGE_NAME_PATHS,
  CGROUP_STAGE_CREATE_INVOCATION,
  CGROUP_STAGE_OPEN_INVOCATION,
  CGROUP_STAGE_VALIDATE_INVOCATION,
  CGROUP_STAGE_DISCOVER_MOUNT,
  CGROUP_STAGE_PROBE,
  CGROUP_STAGE_CREATE_COMMAND,
  CGROUP_STAGE_OPEN_COMMAND,
  CGROUP_STAGE_VALIDATE_COMMAND,
  CGROUP_STAGE_OPEN_CONTROL_FILES,
  CGROUP_STAGE_VALIDATE_EMPTY_COMMAND,
  CGROUP_STAGE_READY,
  CGROUP_STAGE_REMOVE_TREE
};

struct controller {
  uint8_t nonce[GO_LIKE_E2E_NONCE_SIZE];
  uint64_t last_request_id;
  uint64_t prepare_request_id;
  uint64_t start_request_id;
  enum go_like_e2e_controller_state state;
  enum go_like_e2e_process_mode mode;
  uint32_t platform;
  uint32_t capabilities;
  struct target_spec target;
  pid_t anchor_pid;
  pid_t target_pid;
  int anchor_control_fd;
  int anchor_event_fd;
  int target_pidfd;
  bool prepare_pending;
  bool start_pending;
  bool anchor_event_eof;
  bool tracker_inconclusive;
  bool term_sent;
  uint32_t kill_rounds;
  struct target_status target_status;
  struct process_identity *tracked;
  size_t tracked_count;
  size_t tracked_capacity;
  uint8_t input[GO_LIKE_E2E_MAX_WIRE_FRAME];
  size_t input_length;
  uint8_t anchor_input[sizeof(struct anchor_event) * 8u];
  size_t anchor_input_length;
  int exit_code;
#if defined(__linux__)
  struct cgroup_context cgroup;
  enum cgroup_stage cgroup_stage;
  char configured_cgroup_parent[PATH_MAX];
#endif
};

static volatile sig_atomic_t shutdown_signal = 0;

#if defined(__linux__)
static const char *cgroup_stage_name(enum cgroup_stage stage);
static int open_target_pidfd(pid_t pid);
static int pidfd_send_signal_owned(int pidfd, int signal_number);
#endif
static int waitpid_until(pid_t pid, int64_t deadline_ms, int *wait_status);

static void record_shutdown_signal(int signal_number) {
  shutdown_signal = signal_number;
}

static uint16_t load_u16_be(const uint8_t *value) {
  return (uint16_t)(((uint16_t)value[0] << 8u) | (uint16_t)value[1]);
}

static uint32_t load_u32_be(const uint8_t *value) {
  return ((uint32_t)value[0] << 24u) | ((uint32_t)value[1] << 16u) |
         ((uint32_t)value[2] << 8u) | (uint32_t)value[3];
}

static uint64_t load_u64_be(const uint8_t *value) {
  return ((uint64_t)load_u32_be(value) << 32u) | (uint64_t)load_u32_be(value + 4u);
}

static void store_u16_be(uint8_t *target, uint16_t value) {
  target[0] = (uint8_t)(value >> 8u);
  target[1] = (uint8_t)value;
}

static void store_u32_be(uint8_t *target, uint32_t value) {
  target[0] = (uint8_t)(value >> 24u);
  target[1] = (uint8_t)(value >> 16u);
  target[2] = (uint8_t)(value >> 8u);
  target[3] = (uint8_t)value;
}

static void store_u64_be(uint8_t *target, uint64_t value) {
  store_u32_be(target, (uint32_t)(value >> 32u));
  store_u32_be(target + 4u, (uint32_t)value);
}

static int write_all(int fd, const void *data, size_t length) {
  const uint8_t *cursor = data;
  while (length > 0u) {
    ssize_t written = write(fd, cursor, length);
    if (written < 0) {
      if (errno == EINTR) {
        continue;
      }
      return -1;
    }
    if (written == 0) {
      errno = EIO;
      return -1;
    }
    cursor += (size_t)written;
    length -= (size_t)written;
  }
  return 0;
}

static int set_cloexec(int fd) {
  int flags = fcntl(fd, F_GETFD);
  if (flags < 0) {
    return -1;
  }
  return fcntl(fd, F_SETFD, flags | FD_CLOEXEC);
}

static int set_nonblocking(int fd) {
  int flags = fcntl(fd, F_GETFL);
  if (flags < 0) {
    return -1;
  }
  return fcntl(fd, F_SETFL, flags | O_NONBLOCK);
}

static int make_pipe_cloexec(int pipe_fds[2]) {
  if (pipe(pipe_fds) < 0) {
    return -1;
  }
  if (set_cloexec(pipe_fds[0]) < 0 || set_cloexec(pipe_fds[1]) < 0) {
    int saved_errno = errno;
    close(pipe_fds[0]);
    close(pipe_fds[1]);
    errno = saved_errno;
    return -1;
  }
  return 0;
}

static int64_t monotonic_ms(void) {
  struct timespec now;
  if (clock_gettime(CLOCK_MONOTONIC, &now) < 0) {
    return -1;
  }
  return (int64_t)now.tv_sec * 1000 + (int64_t)(now.tv_nsec / 1000000L);
}

static void sleep_until_or_for(int64_t deadline_ms, uint32_t requested_ms) {
  int64_t now = monotonic_ms();
  if (now < 0 || now >= deadline_ms) {
    return;
  }
  int64_t remaining = deadline_ms - now;
  int64_t sleep_ms = remaining < (int64_t)requested_ms ? remaining : (int64_t)requested_ms;
  struct timespec delay;
  delay.tv_sec = (time_t)(sleep_ms / 1000);
  delay.tv_nsec = (long)((sleep_ms % 1000) * 1000000L);
  while (nanosleep(&delay, &delay) < 0 && errno == EINTR) {
    if (shutdown_signal != 0) {
      return;
    }
  }
}

static void byte_buffer_free(struct byte_buffer *buffer) {
  free(buffer->data);
  buffer->data = NULL;
  buffer->length = 0u;
  buffer->capacity = 0u;
}

static int byte_buffer_reserve(struct byte_buffer *buffer, size_t additional) {
  if (additional > GO_LIKE_E2E_MAX_FRAME_BODY ||
      buffer->length > GO_LIKE_E2E_MAX_FRAME_BODY - additional) {
    errno = EOVERFLOW;
    return -1;
  }
  size_t required = buffer->length + additional;
  if (required <= buffer->capacity) {
    return 0;
  }
  size_t capacity = buffer->capacity == 0u ? 64u : buffer->capacity;
  while (capacity < required) {
    if (capacity > GO_LIKE_E2E_MAX_FRAME_BODY / 2u) {
      capacity = GO_LIKE_E2E_MAX_FRAME_BODY;
      break;
    }
    capacity *= 2u;
  }
  uint8_t *next = realloc(buffer->data, capacity);
  if (next == NULL) {
    return -1;
  }
  buffer->data = next;
  buffer->capacity = capacity;
  return 0;
}

static int byte_buffer_append(struct byte_buffer *buffer, const void *data, size_t length) {
  if (byte_buffer_reserve(buffer, length) < 0) {
    return -1;
  }
  memcpy(buffer->data + buffer->length, data, length);
  buffer->length += length;
  return 0;
}

static int byte_buffer_append_u32(struct byte_buffer *buffer, uint32_t value) {
  uint8_t encoded[4];
  store_u32_be(encoded, value);
  return byte_buffer_append(buffer, encoded, sizeof(encoded));
}

static int byte_buffer_append_i32(struct byte_buffer *buffer, int32_t value) {
  return byte_buffer_append_u32(buffer, (uint32_t)value);
}

static bool reader_u32(struct payload_reader *reader, uint32_t *value) {
  if (reader->offset > reader->length || reader->length - reader->offset < 4u) {
    return false;
  }
  *value = load_u32_be(reader->data + reader->offset);
  reader->offset += 4u;
  return true;
}

static bool reader_bytes(struct payload_reader *reader, size_t length, const uint8_t **value) {
  if (reader->offset > reader->length || reader->length - reader->offset < length) {
    return false;
  }
  *value = reader->data + reader->offset;
  reader->offset += length;
  return true;
}

static bool bytes_have_nul(const uint8_t *value, size_t length) {
  return memchr(value, '\0', length) != NULL;
}

static int duplicate_bytes_as_string(const uint8_t *value, size_t length, char **result) {
  if (length > SIZE_MAX - 1u) {
    errno = EOVERFLOW;
    return -1;
  }
  char *copy = malloc(length + 1u);
  if (copy == NULL) {
    return -1;
  }
  memcpy(copy, value, length);
  copy[length] = '\0';
  *result = copy;
  return 0;
}

static void target_spec_free(struct target_spec *target) {
  if (target->argv != NULL) {
    for (size_t index = 0u; index < target->argc; index += 1u) {
      free(target->argv[index]);
    }
  }
  if (target->envp != NULL) {
    for (size_t index = 0u; index < target->envc; index += 1u) {
      free(target->envp[index]);
    }
  }
  free(target->argv);
  free(target->envp);
  free(target->cwd);
  memset(target, 0, sizeof(*target));
}

static bool valid_environment_key(const uint8_t *key, size_t length) {
  return length > 0u && !bytes_have_nul(key, length) && memchr(key, '=', length) == NULL;
}

static int parse_prepare_payload(const uint8_t *payload, size_t payload_length,
                                 enum go_like_e2e_process_mode *mode,
                                 struct target_spec *target) {
  struct payload_reader reader = {payload, payload_length, 0u};
  uint32_t raw_mode = 0u;
  uint32_t argc = 0u;
  uint32_t envc = 0u;
  uint32_t cwd_length = 0u;
  const uint8_t *cwd = NULL;
  struct target_spec parsed;
  memset(&parsed, 0, sizeof(parsed));

  if (!reader_u32(&reader, &raw_mode) || !reader_u32(&reader, &argc) ||
      !reader_u32(&reader, &envc) || !reader_u32(&reader, &cwd_length)) {
    errno = EPROTO;
    return -1;
  }
  if ((raw_mode != GO_LIKE_E2E_MODE_ANCHORED_MANAGED &&
       raw_mode != GO_LIKE_E2E_MODE_LINUX_CGROUP_V2_STRICT) ||
      argc == 0u || argc > GO_LIKE_E2E_MAX_ARGC || envc > GO_LIKE_E2E_MAX_ENVC ||
      cwd_length == 0u || cwd_length > GO_LIKE_E2E_MAX_CWD_BYTES ||
      !reader_bytes(&reader, cwd_length, &cwd) || bytes_have_nul(cwd, cwd_length) ||
      cwd[0] != '/') {
    errno = EINVAL;
    return -1;
  }
  if (duplicate_bytes_as_string(cwd, cwd_length, &parsed.cwd) < 0) {
    goto failed;
  }
  parsed.argv = calloc((size_t)argc + 1u, sizeof(char *));
  if (parsed.argv == NULL) {
    goto failed;
  }
  parsed.argc = argc;
  for (size_t index = 0u; index < parsed.argc; index += 1u) {
    uint32_t length = 0u;
    const uint8_t *value = NULL;
    if (!reader_u32(&reader, &length) || length > GO_LIKE_E2E_MAX_STRING_BYTES ||
        (index == 0u && length == 0u) || !reader_bytes(&reader, length, &value) ||
        bytes_have_nul(value, length) ||
        duplicate_bytes_as_string(value, length, &parsed.argv[index]) < 0) {
      errno = EINVAL;
      goto failed;
    }
  }
  parsed.envp = calloc((size_t)envc + 1u, sizeof(char *));
  if (parsed.envp == NULL) {
    goto failed;
  }
  parsed.envc = envc;
  for (size_t index = 0u; index < parsed.envc; index += 1u) {
    uint32_t key_length = 0u;
    uint32_t value_length = 0u;
    const uint8_t *key = NULL;
    const uint8_t *value = NULL;
    if (!reader_u32(&reader, &key_length) || !reader_u32(&reader, &value_length) ||
        key_length > GO_LIKE_E2E_MAX_STRING_BYTES ||
        value_length > GO_LIKE_E2E_MAX_STRING_BYTES ||
        !reader_bytes(&reader, key_length, &key) ||
        !reader_bytes(&reader, value_length, &value) ||
        !valid_environment_key(key, key_length) || bytes_have_nul(value, value_length)) {
      errno = EINVAL;
      goto failed;
    }
    for (size_t previous = 0u; previous < index; previous += 1u) {
      const char *separator = strchr(parsed.envp[previous], '=');
      size_t previous_length = separator == NULL ? 0u : (size_t)(separator - parsed.envp[previous]);
      if (previous_length == key_length && memcmp(parsed.envp[previous], key, key_length) == 0) {
        errno = EINVAL;
        goto failed;
      }
    }
    if ((size_t)key_length > SIZE_MAX - (size_t)value_length - 2u) {
      errno = EOVERFLOW;
      goto failed;
    }
    size_t entry_length = (size_t)key_length + 1u + (size_t)value_length;
    parsed.envp[index] = malloc(entry_length + 1u);
    if (parsed.envp[index] == NULL) {
      goto failed;
    }
    memcpy(parsed.envp[index], key, key_length);
    parsed.envp[index][key_length] = '=';
    memcpy(parsed.envp[index] + key_length + 1u, value, value_length);
    parsed.envp[index][entry_length] = '\0';
  }
  if (reader.offset != reader.length) {
    errno = EPROTO;
    goto failed;
  }
  *mode = (enum go_like_e2e_process_mode)raw_mode;
  *target = parsed;
  return 0;

failed:
  target_spec_free(&parsed);
  return -1;
}

static int send_frame(const struct controller *controller, uint16_t type, uint32_t flags,
                      uint64_t request_id, const uint8_t *payload, size_t payload_length) {
  if (payload_length > GO_LIKE_E2E_MAX_FRAME_BODY - GO_LIKE_E2E_FRAME_HEADER_SIZE) {
    errno = EOVERFLOW;
    return -1;
  }
  uint8_t prefix[GO_LIKE_E2E_FRAME_PREFIX_SIZE];
  uint8_t header[GO_LIKE_E2E_FRAME_HEADER_SIZE];
  uint32_t body_length = (uint32_t)(GO_LIKE_E2E_FRAME_HEADER_SIZE + payload_length);
  store_u32_be(prefix, body_length);
  memset(header, 0, sizeof(header));
  store_u32_be(header + GO_LIKE_E2E_HEADER_MAGIC_OFFSET, GO_LIKE_E2E_FRAME_MAGIC);
  store_u16_be(header + GO_LIKE_E2E_HEADER_VERSION_OFFSET, GO_LIKE_E2E_PROTOCOL_VERSION);
  store_u16_be(header + GO_LIKE_E2E_HEADER_TYPE_OFFSET, type);
  store_u32_be(header + GO_LIKE_E2E_HEADER_FLAGS_OFFSET, flags);
  store_u64_be(header + GO_LIKE_E2E_HEADER_REQUEST_ID_OFFSET, request_id);
  memcpy(header + GO_LIKE_E2E_HEADER_NONCE_OFFSET, controller->nonce,
         GO_LIKE_E2E_NONCE_SIZE);
  if (write_all(GO_LIKE_E2E_RESPONSE_FD, prefix, sizeof(prefix)) < 0 ||
      write_all(GO_LIKE_E2E_RESPONSE_FD, header, sizeof(header)) < 0 ||
      (payload_length > 0u &&
       write_all(GO_LIKE_E2E_RESPONSE_FD, payload, payload_length) < 0)) {
    return -1;
  }
  return 0;
}

static int send_error(const struct controller *controller, uint64_t request_id,
                      enum go_like_e2e_error_code error_code, int system_errno, bool terminal,
                      const char *message) {
  struct byte_buffer payload = {0};
  size_t message_length = strlen(message);
  if (message_length > GO_LIKE_E2E_ERROR_MESSAGE_MAX) {
    message_length = GO_LIKE_E2E_ERROR_MESSAGE_MAX;
  }
  int result = -1;
  if (byte_buffer_append_u32(&payload, (uint32_t)error_code) < 0 ||
      byte_buffer_append_i32(&payload, (int32_t)system_errno) < 0 ||
      byte_buffer_append_u32(&payload, terminal ? 1u : 0u) < 0 ||
      byte_buffer_append_u32(&payload, (uint32_t)message_length) < 0 ||
      byte_buffer_append(&payload, message, message_length) < 0) {
    goto done;
  }
  result = send_frame(controller, GO_LIKE_E2E_RESPONSE_ERROR,
                      terminal ? GO_LIKE_E2E_RESPONSE_FLAG_TERMINAL : 0u, request_id,
                      payload.data, payload.length);
done:
  byte_buffer_free(&payload);
  return result;
}

static int random_nonce(uint8_t nonce[GO_LIKE_E2E_NONCE_SIZE]) {
#if defined(__APPLE__)
  arc4random_buf(nonce, GO_LIKE_E2E_NONCE_SIZE);
  return 0;
#elif defined(__linux__)
  size_t offset = 0u;
  while (offset < GO_LIKE_E2E_NONCE_SIZE) {
    ssize_t count = getrandom(nonce + offset, GO_LIKE_E2E_NONCE_SIZE - offset, 0u);
    if (count < 0) {
      if (errno == EINTR) {
        continue;
      }
      return -1;
    }
    offset += (size_t)count;
  }
  return 0;
#endif
}

static bool nonce_equal(const uint8_t *left, const uint8_t *right) {
  uint8_t difference = 0u;
  for (size_t index = 0u; index < GO_LIKE_E2E_NONCE_SIZE; index += 1u) {
    difference |= (uint8_t)(left[index] ^ right[index]);
  }
  return difference == 0u;
}

static int parse_request_body(const uint8_t *body, size_t body_length,
                              struct request_frame *frame) {
  if (body_length < GO_LIKE_E2E_FRAME_HEADER_SIZE) {
    errno = EPROTO;
    return -1;
  }
  if (load_u32_be(body + GO_LIKE_E2E_HEADER_MAGIC_OFFSET) != GO_LIKE_E2E_FRAME_MAGIC) {
    errno = EPROTO;
    return -1;
  }
  if (load_u16_be(body + GO_LIKE_E2E_HEADER_VERSION_OFFSET) !=
      GO_LIKE_E2E_PROTOCOL_VERSION) {
    errno = EPROTONOSUPPORT;
    return -1;
  }
  frame->type = load_u16_be(body + GO_LIKE_E2E_HEADER_TYPE_OFFSET);
  frame->flags = load_u32_be(body + GO_LIKE_E2E_HEADER_FLAGS_OFFSET);
  frame->request_id = load_u64_be(body + GO_LIKE_E2E_HEADER_REQUEST_ID_OFFSET);
  frame->nonce = body + GO_LIKE_E2E_HEADER_NONCE_OFFSET;
  frame->payload = body + GO_LIKE_E2E_HEADER_PAYLOAD_OFFSET;
  frame->payload_length = body_length - GO_LIKE_E2E_FRAME_HEADER_SIZE;
  return 0;
}

static const char *target_environment_value(const struct target_spec *target,
                                            const char *key) {
  size_t key_length = strlen(key);
  for (size_t index = 0u; index < target->envc; index += 1u) {
    if (strncmp(target->envp[index], key, key_length) == 0 &&
        target->envp[index][key_length] == '=') {
      return target->envp[index] + key_length + 1u;
    }
  }
  return NULL;
}

static void exec_target_with_path(const struct target_spec *target) {
  const char *program = target->argv[0];
  if (strchr(program, '/') != NULL) {
    execve(program, target->argv, target->envp);
    return;
  }
  const char *path = target_environment_value(target, "PATH");
  if (path == NULL || path[0] == '\0') {
    path = "/usr/bin:/bin";
  }
  int remembered_errno = ENOENT;
  const char *segment = path;
  while (true) {
    const char *separator = strchr(segment, ':');
    size_t directory_length =
        separator == NULL ? strlen(segment) : (size_t)(separator - segment);
    const char *directory = segment;
    if (directory_length == 0u) {
      directory = ".";
      directory_length = 1u;
    }
    size_t program_length = strlen(program);
    if (directory_length <= PATH_MAX && program_length <= PATH_MAX &&
        directory_length + 1u + program_length < PATH_MAX) {
      char candidate[PATH_MAX];
      memcpy(candidate, directory, directory_length);
      candidate[directory_length] = '/';
      memcpy(candidate + directory_length + 1u, program, program_length + 1u);
      execve(candidate, target->argv, target->envp);
      if (errno == EACCES) {
        remembered_errno = EACCES;
      } else if (errno != ENOENT && errno != ENOTDIR) {
        remembered_errno = errno;
      }
    } else {
      remembered_errno = ENAMETOOLONG;
    }
    if (separator == NULL) {
      break;
    }
    segment = separator + 1u;
  }
  errno = remembered_errno;
}

static void reset_target_signals(void) {
  const int signals[] = {SIGTERM, SIGINT, SIGHUP, SIGPIPE, SIGCHLD};
  struct sigaction action;
  memset(&action, 0, sizeof(action));
  action.sa_handler = SIG_DFL;
  sigemptyset(&action.sa_mask);
  for (size_t index = 0u; index < ARRAY_LENGTH(signals); index += 1u) {
    (void)sigaction(signals[index], &action, NULL);
  }
  sigset_t empty;
  sigemptyset(&empty);
  (void)sigprocmask(SIG_SETMASK, &empty, NULL);
}

static int relocate_exec_error_fd(int fd) {
  if (fd == 3) {
    return set_cloexec(fd);
  }
  if (dup2(fd, 3) < 0) {
    return -1;
  }
  close(fd);
  return set_cloexec(3);
}

static void close_target_fds_above_three(void) {
#if defined(__linux__) && defined(SYS_close_range)
  if (syscall(SYS_close_range, 4u, ~0u, 0u) == 0) {
    return;
  }
#endif
  struct rlimit limit;
  rlim_t maximum = 65536u;
  if (getrlimit(RLIMIT_NOFILE, &limit) == 0) {
    maximum = limit.rlim_cur;
    if (maximum == RLIM_INFINITY || maximum > 1048576u) {
      maximum = 1048576u;
    }
  }
  for (int fd = 4; (rlim_t)fd < maximum; fd += 1) {
    close(fd);
  }
}

static void child_exec_target(const struct target_spec *target, int exec_error_fd) {
  int null_fd = open("/dev/null", O_RDONLY | O_CLOEXEC);
  if (null_fd < 0 || dup2(null_fd, STDIN_FILENO) < 0 ||
      dup2(GO_LIKE_E2E_TARGET_STDOUT_FD, STDOUT_FILENO) < 0 ||
      dup2(GO_LIKE_E2E_TARGET_STDERR_FD, STDERR_FILENO) < 0 ||
      relocate_exec_error_fd(exec_error_fd) < 0) {
    int child_errno = errno;
    if (exec_error_fd >= 0) {
      (void)write_all(exec_error_fd, &child_errno, sizeof(child_errno));
    }
    _exit(127);
  }
  if (null_fd > 3) {
    close(null_fd);
  }
  close_target_fds_above_three();
  reset_target_signals();
  if (chdir(target->cwd) < 0) {
    int child_errno = errno;
    (void)write_all(3, &child_errno, sizeof(child_errno));
    _exit(127);
  }
  exec_target_with_path(target);
  int child_errno = errno;
  (void)write_all(3, &child_errno, sizeof(child_errno));
  _exit(127);
}

static void status_from_wait_status(int wait_status, struct target_status *status) {
  status->known = true;
  status->core_dumped = 0u;
  if (WIFEXITED(wait_status)) {
    status->exit_kind = GO_LIKE_E2E_EXIT_CODE;
    status->exit_value = (int32_t)WEXITSTATUS(wait_status);
  } else if (WIFSIGNALED(wait_status)) {
    status->exit_kind = GO_LIKE_E2E_EXIT_SIGNAL;
    status->exit_value = (int32_t)WTERMSIG(wait_status);
#ifdef WCOREDUMP
    status->core_dumped = WCOREDUMP(wait_status) ? 1u : 0u;
#endif
  } else {
    status->exit_kind = GO_LIKE_E2E_EXIT_UNKNOWN;
    status->exit_value = 0;
  }
}

static int anchor_send_event(int fd, uint32_t kind, int32_t value, uint32_t pid,
                             uint32_t auxiliary) {
  struct anchor_event event;
  event.kind = kind;
  event.value = value;
  event.pid = pid;
  event.auxiliary = auxiliary;
  return write_all(fd, &event, sizeof(event));
}

static int anchor_wait_for_exec(int exec_read_fd, int *exec_errno) {
  uint8_t buffer[sizeof(int)];
  size_t offset = 0u;
  while (offset < sizeof(buffer)) {
    ssize_t count = read(exec_read_fd, buffer + offset, sizeof(buffer) - offset);
    if (count == 0) {
      if (offset == 0u) {
        return 0;
      }
      errno = EPROTO;
      return -1;
    }
    if (count < 0) {
      if (errno == EINTR) {
        continue;
      }
      return -1;
    }
    offset += (size_t)count;
  }
  memcpy(exec_errno, buffer, sizeof(*exec_errno));
  return 1;
}

static void anchor_process(const struct target_spec *target,
                           enum go_like_e2e_process_mode mode, int control_fd, int event_fd,
                           int cgroup_procs_fd) {
  close(GO_LIKE_E2E_CONTROL_FD);
  close(GO_LIKE_E2E_RESPONSE_FD);
  struct sigaction ignored;
  memset(&ignored, 0, sizeof(ignored));
  ignored.sa_handler = SIG_IGN;
  sigemptyset(&ignored.sa_mask);
  (void)sigaction(SIGTERM, &ignored, NULL);
  (void)sigaction(SIGINT, &ignored, NULL);
  (void)sigaction(SIGHUP, &ignored, NULL);
  (void)sigaction(SIGPIPE, &ignored, NULL);

  if (setsid() < 0 || getpgrp() != getpid() || getsid(0) != getpid()) {
    int anchor_errno = errno == 0 ? EPROTO : errno;
    (void)anchor_send_event(event_fd, ANCHOR_EVENT_ERROR, anchor_errno, 0u, 0u);
    _exit(120);
  }
#if defined(__linux__)
  if (mode == GO_LIKE_E2E_MODE_LINUX_CGROUP_V2_STRICT) {
    char pid_text[32];
    int length = snprintf(pid_text, sizeof(pid_text), "%ld", (long)getpid());
    if (cgroup_procs_fd < 0 || length <= 0 || (size_t)length >= sizeof(pid_text) ||
        write_all(cgroup_procs_fd, pid_text, (size_t)length) < 0) {
      int anchor_errno = errno == 0 ? EIO : errno;
      (void)anchor_send_event(event_fd, ANCHOR_EVENT_ERROR, anchor_errno, 0u, 0u);
      _exit(121);
    }
    close(cgroup_procs_fd);
    cgroup_procs_fd = -1;
  }
#else
  (void)mode;
  (void)cgroup_procs_fd;
#endif
  if (anchor_send_event(event_fd, ANCHOR_EVENT_READY, 0, (uint32_t)getpid(), 0u) < 0) {
    _exit(122);
  }

  pid_t target_pid = -1;
  bool target_done = false;
  bool started = false;
  while (true) {
    if (started && !target_done) {
      int wait_status = 0;
      pid_t waited = waitpid(target_pid, &wait_status, WNOHANG);
      if (waited == target_pid) {
        struct target_status status = {0};
        status_from_wait_status(wait_status, &status);
        (void)anchor_send_event(event_fd, ANCHOR_EVENT_TARGET_EXIT, status.exit_value,
                                (uint32_t)target_pid,
                                (status.exit_kind & 0xffffu) |
                                    ((status.core_dumped & 1u) << 16u));
        target_done = true;
      } else if (waited < 0 && errno != EINTR) {
        (void)anchor_send_event(event_fd, ANCHOR_EVENT_ERROR, errno, 0u, 0u);
        _exit(123);
      }
    }

    struct pollfd poll_fd;
    poll_fd.fd = control_fd;
    poll_fd.events = POLLIN | POLLHUP | POLLERR;
    poll_fd.revents = 0;
    int polled = poll(&poll_fd, 1u, GO_LIKE_E2E_INTERNAL_POLL_MS);
    if (polled < 0) {
      if (errno == EINTR) {
        continue;
      }
      (void)anchor_send_event(event_fd, ANCHOR_EVENT_ERROR, errno, 0u, 0u);
      _exit(124);
    }
    if (polled == 0) {
      continue;
    }
    if ((poll_fd.revents & POLLIN) != 0) {
      struct anchor_command command;
      ssize_t count;
      do {
        count = read(control_fd, &command, sizeof(command));
      } while (count < 0 && errno == EINTR);
      if (count == 0) {
        _exit(125);
      }
      if (count != (ssize_t)sizeof(command)) {
        (void)anchor_send_event(event_fd, ANCHOR_EVENT_ERROR, EPROTO, 0u, 0u);
        _exit(126);
      }
      if (command.kind == ANCHOR_COMMAND_EXIT) {
        _exit(0);
      }
      if (command.kind != ANCHOR_COMMAND_START || started) {
        (void)anchor_send_event(event_fd, ANCHOR_EVENT_ERROR, EPROTO, 0u, 0u);
        _exit(127);
      }

      int exec_pipe[2];
      if (make_pipe_cloexec(exec_pipe) < 0) {
        (void)anchor_send_event(event_fd, ANCHOR_EVENT_ERROR, errno, 0u, 0u);
        _exit(128);
      }
      target_pid = fork();
      if (target_pid < 0) {
        int fork_errno = errno;
        close(exec_pipe[0]);
        close(exec_pipe[1]);
        (void)anchor_send_event(event_fd, ANCHOR_EVENT_ERROR, fork_errno, 0u, 0u);
        _exit(129);
      }
      if (target_pid == 0) {
        close(exec_pipe[0]);
        child_exec_target(target, exec_pipe[1]);
      }
      close(exec_pipe[1]);
      close(GO_LIKE_E2E_TARGET_STDOUT_FD);
      close(GO_LIKE_E2E_TARGET_STDERR_FD);
      int exec_errno = 0;
      int exec_result = anchor_wait_for_exec(exec_pipe[0], &exec_errno);
      close(exec_pipe[0]);
      started = true;
      if (exec_result == 0) {
        if (anchor_send_event(event_fd, ANCHOR_EVENT_TARGET_STARTED, 0,
                              (uint32_t)target_pid, 0u) < 0) {
          _exit(130);
        }
      } else {
        int wait_status = 0;
        while (waitpid(target_pid, &wait_status, 0) < 0 && errno == EINTR) {
        }
        int reported_errno = exec_result > 0 ? exec_errno : errno;
        (void)anchor_send_event(event_fd, ANCHOR_EVENT_TARGET_EXIT, reported_errno,
                                (uint32_t)target_pid,
                                GO_LIKE_E2E_EXIT_EXEC_FAILURE & 0xffffu);
        target_done = true;
      }
    }
    if ((poll_fd.revents & (POLLHUP | POLLERR)) != 0) {
      _exit(131);
    }
  }
}

static int controller_send_anchor_command(struct controller *controller, uint32_t kind) {
  struct anchor_command command;
  command.kind = kind;
  return write_all(controller->anchor_control_fd, &command, sizeof(command));
}

static void controller_close_anchor_control(struct controller *controller) {
  if (controller->anchor_control_fd >= 0) {
    (void)shutdown(controller->anchor_control_fd, SHUT_RDWR);
    close(controller->anchor_control_fd);
    controller->anchor_control_fd = -1;
  }
}

static int tracker_add(struct controller *controller, pid_t pid, uint64_t start_identity) {
  if (pid <= 0 || start_identity == 0u) {
    return 0;
  }
  for (size_t index = 0u; index < controller->tracked_count; index += 1u) {
    if (controller->tracked[index].pid == pid &&
        controller->tracked[index].start_identity == start_identity) {
      return 0;
    }
  }
  if (controller->tracked_count >= GO_LIKE_E2E_MAX_TRACKED_PROCESSES) {
    errno = EOVERFLOW;
    return -1;
  }
  if (controller->tracked_count == controller->tracked_capacity) {
    size_t capacity = controller->tracked_capacity == 0u ? 32u : controller->tracked_capacity * 2u;
    if (capacity > GO_LIKE_E2E_MAX_TRACKED_PROCESSES) {
      capacity = GO_LIKE_E2E_MAX_TRACKED_PROCESSES;
    }
    struct process_identity *next =
        realloc(controller->tracked, capacity * sizeof(*controller->tracked));
    if (next == NULL) {
      return -1;
    }
    controller->tracked = next;
    controller->tracked_capacity = capacity;
  }
  controller->tracked[controller->tracked_count].pid = pid;
  controller->tracked[controller->tracked_count].start_identity = start_identity;
  controller->tracked_count += 1u;
  return 0;
}

static bool tracker_contains(const struct controller *controller,
                             const struct process_record *record) {
  for (size_t index = 0u; index < controller->tracked_count; index += 1u) {
    if (controller->tracked[index].pid == record->pid &&
        controller->tracked[index].start_identity == record->start_identity) {
      return true;
    }
  }
  return false;
}

static void process_snapshot_free(struct process_snapshot *snapshot) {
  free(snapshot->records);
  snapshot->records = NULL;
  snapshot->count = 0u;
}

#if defined(__APPLE__)
static int take_process_snapshot(struct process_snapshot *snapshot) {
  memset(snapshot, 0, sizeof(*snapshot));
  int estimate = proc_listallpids(NULL, 0);
  if (estimate <= 0) {
    errno = EIO;
    return -1;
  }
  size_t capacity = (size_t)estimate + 128u;
  if (capacity > GO_LIKE_E2E_MAX_TRACKED_PROCESSES) {
    capacity = GO_LIKE_E2E_MAX_TRACKED_PROCESSES;
  }
  pid_t *pids = calloc(capacity, sizeof(*pids));
  struct process_record *records = calloc(capacity, sizeof(*records));
  if (pids == NULL || records == NULL) {
    free(pids);
    free(records);
    return -1;
  }
  int count = proc_listallpids(pids, (int)(capacity * sizeof(*pids)));
  if (count < 0) {
    free(pids);
    free(records);
    return -1;
  }
  if ((size_t)count >= capacity) {
    free(pids);
    free(records);
    errno = EOVERFLOW;
    return -1;
  }
  size_t used = 0u;
  for (int index = 0; index < count; index += 1) {
    if (pids[index] <= 0) {
      continue;
    }
    struct proc_bsdinfo info;
    memset(&info, 0, sizeof(info));
    errno = 0;
    int bytes = proc_pidinfo(pids[index], PROC_PIDTBSDINFO, 0u, &info, sizeof(info));
    if (bytes != (int)sizeof(info)) {
      if (errno != ESRCH && errno != ENOENT && errno != EPERM && errno != EACCES) {
        int query_errno = errno == 0 ? EIO : errno;
        free(pids);
        free(records);
        errno = query_errno;
        return -1;
      }
      continue;
    }
    records[used].pid = (pid_t)info.pbi_pid;
    records[used].ppid = (pid_t)info.pbi_ppid;
    records[used].pgid = (pid_t)info.pbi_pgid;
    records[used].sid = 0;
    records[used].start_identity =
        info.pbi_start_tvsec * UINT64_C(1000000) + info.pbi_start_tvusec;
    records[used].zombie = info.pbi_status == SZOMB;
    used += 1u;
  }
  free(pids);
  snapshot->records = records;
  snapshot->count = used;
  return 0;
}
#elif defined(__linux__)
static int parse_linux_stat(pid_t pid, struct process_record *record) {
  char path[64];
  int path_length = snprintf(path, sizeof(path), "/proc/%ld/stat", (long)pid);
  if (path_length <= 0 || (size_t)path_length >= sizeof(path)) {
    errno = ENAMETOOLONG;
    return -1;
  }
  int fd = open(path, O_RDONLY | O_CLOEXEC);
  if (fd < 0) {
    return errno == ENOENT || errno == ESRCH ? 0 : -1;
  }
  char buffer[4096];
  ssize_t count;
  do {
    count = read(fd, buffer, sizeof(buffer) - 1u);
  } while (count < 0 && errno == EINTR);
  int read_errno = errno;
  close(fd);
  if (count < 0) {
    errno = read_errno;
    return errno == ENOENT || errno == ESRCH ? 0 : -1;
  }
  if (count == 0) {
    errno = EPROTO;
    return -1;
  }
  buffer[count] = '\0';
  char *right_parenthesis = strrchr(buffer, ')');
  if (right_parenthesis == NULL || right_parenthesis[1] != ' ') {
    errno = EPROTO;
    return -1;
  }
  char *cursor = right_parenthesis + 2u;
  unsigned field = 3u;
  char state = '\0';
  long ppid = -1;
  long pgid = -1;
  long sid = -1;
  uint64_t start_identity = 0u;
  while (*cursor != '\0' && field <= 22u) {
    char *end = NULL;
    if (field == 3u) {
      state = *cursor;
      end = cursor + 1u;
    } else if (field == 22u) {
      errno = 0;
      unsigned long long value = strtoull(cursor, &end, 10);
      if (errno != 0 || end == cursor) {
        errno = EPROTO;
        return -1;
      }
      start_identity = (uint64_t)value;
    } else {
      errno = 0;
      long value = strtol(cursor, &end, 10);
      if (errno != 0 || end == cursor) {
        errno = EPROTO;
        return -1;
      }
      if (field == 4u) {
        ppid = value;
      } else if (field == 5u) {
        pgid = value;
      } else if (field == 6u) {
        sid = value;
      }
    }
    while (*end == ' ') {
      end += 1u;
    }
    cursor = end;
    field += 1u;
  }
  if (field <= 22u || ppid < 0 || pgid < 0 || sid < 0 || start_identity == 0u) {
    errno = EPROTO;
    return -1;
  }
  record->pid = pid;
  record->ppid = (pid_t)ppid;
  record->pgid = (pid_t)pgid;
  record->sid = (pid_t)sid;
  record->start_identity = start_identity;
  record->zombie = state == 'Z';
  return 1;
}

static int take_process_snapshot(struct process_snapshot *snapshot) {
  memset(snapshot, 0, sizeof(*snapshot));
  DIR *directory = opendir("/proc");
  if (directory == NULL) {
    return -1;
  }
  size_t capacity = 256u;
  struct process_record *records = calloc(capacity, sizeof(*records));
  if (records == NULL) {
    closedir(directory);
    return -1;
  }
  size_t count = 0u;
  struct dirent *entry;
  while ((entry = readdir(directory)) != NULL) {
    char *end = NULL;
    errno = 0;
    long raw_pid = strtol(entry->d_name, &end, 10);
    if (errno != 0 || end == entry->d_name || *end != '\0' || raw_pid <= 0 ||
        raw_pid > INT_MAX) {
      continue;
    }
    struct process_record record;
    memset(&record, 0, sizeof(record));
    int parsed = parse_linux_stat((pid_t)raw_pid, &record);
    if (parsed < 0) {
      int parse_errno = errno;
      free(records);
      closedir(directory);
      errno = parse_errno;
      return -1;
    }
    if (parsed == 0) {
      continue;
    }
    if (count == capacity) {
      if (capacity >= GO_LIKE_E2E_MAX_TRACKED_PROCESSES) {
        free(records);
        closedir(directory);
        errno = EOVERFLOW;
        return -1;
      }
      size_t next_capacity = capacity * 2u;
      if (next_capacity > GO_LIKE_E2E_MAX_TRACKED_PROCESSES) {
        next_capacity = GO_LIKE_E2E_MAX_TRACKED_PROCESSES;
      }
      struct process_record *next = realloc(records, next_capacity * sizeof(*records));
      if (next == NULL) {
        free(records);
        closedir(directory);
        return -1;
      }
      records = next;
      capacity = next_capacity;
    }
    records[count] = record;
    count += 1u;
  }
  closedir(directory);
  snapshot->records = records;
  snapshot->count = count;
  return 0;
}
#endif

static int observe_managed_processes(struct controller *controller,
                                     struct observation *observation) {
  struct process_snapshot snapshot;
  if (take_process_snapshot(&snapshot) < 0) {
    return -1;
  }
  memset(observation, 0, sizeof(*observation));
  for (size_t index = 0u; index < snapshot.count; index += 1u) {
    struct process_record *record = &snapshot.records[index];
    if (tracker_contains(controller, record) || record->pid == controller->anchor_pid) {
      record->owned = true;
    }
  }
  bool changed = true;
  while (changed) {
    changed = false;
    for (size_t child_index = 0u; child_index < snapshot.count; child_index += 1u) {
      struct process_record *child = &snapshot.records[child_index];
      if (child->owned) {
        continue;
      }
      for (size_t parent_index = 0u; parent_index < snapshot.count; parent_index += 1u) {
        const struct process_record *parent = &snapshot.records[parent_index];
        if (parent->owned && child->ppid == parent->pid) {
          child->owned = true;
          changed = true;
          break;
        }
      }
    }
  }
  int result = 0;
  for (size_t index = 0u; index < snapshot.count; index += 1u) {
    struct process_record *record = &snapshot.records[index];
    if (record->owned && tracker_add(controller, record->pid, record->start_identity) < 0) {
      result = -1;
      break;
    }
    if (record->zombie || record->pid == controller->anchor_pid) {
      continue;
    }
    if (record->pgid == controller->anchor_pid) {
      observation->same_group_live += 1u;
    } else if (record->owned) {
      observation->breakaway_live += 1u;
    }
  }
  process_snapshot_free(&snapshot);
  return result;
}

static int refresh_tracker(struct controller *controller) {
  struct observation ignored;
  if (observe_managed_processes(controller, &ignored) < 0) {
    controller->tracker_inconclusive = true;
    return -1;
  }
  return 0;
}

static int record_anchor_identity(struct controller *controller) {
  struct process_snapshot snapshot;
  if (take_process_snapshot(&snapshot) < 0) {
    return -1;
  }
  int result = -1;
  for (size_t index = 0u; index < snapshot.count; index += 1u) {
    if (snapshot.records[index].pid == controller->anchor_pid) {
      result = tracker_add(controller, snapshot.records[index].pid,
                           snapshot.records[index].start_identity);
      break;
    }
  }
  process_snapshot_free(&snapshot);
  if (result < 0) {
    errno = ESRCH;
  }
  return result;
}

#if defined(__linux__)
static void cgroup_context_initialize(struct cgroup_context *context) {
  memset(context, 0, sizeof(*context));
  context->parent_fd = -1;
  context->invocation_fd = -1;
  context->command_fd = -1;
  context->procs_fd = -1;
  context->kill_fd = -1;
  context->events_fd = -1;
}

static void cgroup_close_control_fds(struct cgroup_context *context) {
  if (context->procs_fd >= 0) {
    close(context->procs_fd);
    context->procs_fd = -1;
  }
  if (context->kill_fd >= 0) {
    close(context->kill_fd);
    context->kill_fd = -1;
  }
  if (context->events_fd >= 0) {
    close(context->events_fd);
    context->events_fd = -1;
  }
  if (context->command_fd >= 0) {
    close(context->command_fd);
    context->command_fd = -1;
  }
  if (context->invocation_fd >= 0) {
    close(context->invocation_fd);
    context->invocation_fd = -1;
  }
}

static void cgroup_context_close(struct cgroup_context *context) {
  cgroup_close_control_fds(context);
  if (context->parent_fd >= 0) {
    close(context->parent_fd);
    context->parent_fd = -1;
  }
}

static int read_fd_text(int fd, char *buffer, size_t capacity) {
  if (capacity == 0u) {
    errno = EINVAL;
    return -1;
  }
  if (lseek(fd, 0, SEEK_SET) < 0) {
    return -1;
  }
  ssize_t count;
  do {
    count = read(fd, buffer, capacity - 1u);
  } while (count < 0 && errno == EINTR);
  if (count < 0) {
    return -1;
  }
  if ((size_t)count == capacity - 1u) {
    errno = EOVERFLOW;
    return -1;
  }
  buffer[count] = '\0';
  return (int)count;
}

static int read_file_at(int directory_fd, const char *name, char *buffer, size_t capacity) {
  int fd = openat(directory_fd, name, O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
  if (fd < 0) {
    return -1;
  }
  int result = read_fd_text(fd, buffer, capacity);
  int saved_errno = errno;
  close(fd);
  errno = saved_errno;
  return result;
}

static int parse_cgroup_populated_fd(int events_fd, uint32_t *populated) {
  char events[4096];
  if (read_fd_text(events_fd, events, sizeof(events)) < 0) {
    return -1;
  }
  char *line = events;
  while (*line != '\0') {
    char *newline = strchr(line, '\n');
    if (newline != NULL) {
      *newline = '\0';
    }
    unsigned value = 0u;
    char extra = '\0';
    if (sscanf(line, "populated %u%c", &value, &extra) == 1 && value <= 1u) {
      *populated = value;
      return 0;
    }
    if (newline == NULL) {
      break;
    }
    line = newline + 1u;
  }
  errno = EPROTO;
  return -1;
}

static int decode_mountinfo_path(const char *encoded, char *decoded, size_t capacity) {
  size_t output = 0u;
  for (size_t input = 0u; encoded[input] != '\0'; input += 1u) {
    unsigned char value = (unsigned char)encoded[input];
    if (value == '\\' && encoded[input + 1u] >= '0' && encoded[input + 1u] <= '7' &&
        encoded[input + 2u] >= '0' && encoded[input + 2u] <= '7' &&
        encoded[input + 3u] >= '0' && encoded[input + 3u] <= '7') {
      value = (unsigned char)(((encoded[input + 1u] - '0') << 6u) |
                              ((encoded[input + 2u] - '0') << 3u) |
                              (encoded[input + 3u] - '0'));
      input += 3u;
    }
    if (output + 1u >= capacity) {
      errno = ENAMETOOLONG;
      return -1;
    }
    decoded[output] = (char)value;
    output += 1u;
  }
  decoded[output] = '\0';
  return 0;
}

static bool path_is_within(const char *path, const char *directory) {
  size_t length = strlen(directory);
  if (strncmp(path, directory, length) != 0) {
    return false;
  }
  return path[length] == '\0' || (length == 1u && directory[0] == '/') || path[length] == '/';
}

static int find_cgroup2_mount(const char *parent_realpath, struct cgroup_mount *mount) {
  FILE *file = fopen("/proc/self/mountinfo", "re");
  if (file == NULL) {
    return -1;
  }
  char *line = NULL;
  size_t line_capacity = 0u;
  ssize_t length;
  size_t best_length = 0u;
  int result = -1;
  while ((length = getline(&line, &line_capacity, file)) >= 0) {
    (void)length;
    char *separator = strstr(line, " - cgroup2 ");
    if (separator == NULL) {
      continue;
    }
    *separator = '\0';
    char *save = NULL;
    char *token = strtok_r(line, " ", &save);
    unsigned field = 1u;
    const char *root_token = NULL;
    const char *mountpoint_token = NULL;
    while (token != NULL && field <= 5u) {
      if (field == 4u) {
        root_token = token;
      } else if (field == 5u) {
        mountpoint_token = token;
      }
      token = strtok_r(NULL, " ", &save);
      field += 1u;
    }
    if (root_token == NULL || mountpoint_token == NULL) {
      continue;
    }
    char decoded_root[PATH_MAX];
    char decoded_mountpoint[PATH_MAX];
    if (decode_mountinfo_path(root_token, decoded_root, sizeof(decoded_root)) < 0 ||
        decode_mountinfo_path(mountpoint_token, decoded_mountpoint,
                              sizeof(decoded_mountpoint)) < 0) {
      continue;
    }
    size_t mountpoint_length = strlen(decoded_mountpoint);
    if (mountpoint_length > best_length && path_is_within(parent_realpath, decoded_mountpoint)) {
      memcpy(mount->root, decoded_root, strlen(decoded_root) + 1u);
      memcpy(mount->mountpoint, decoded_mountpoint, mountpoint_length + 1u);
      best_length = mountpoint_length;
      result = 0;
    }
  }
  free(line);
  fclose(file);
  if (result < 0) {
    errno = ENODEV;
  }
  return result;
}

static int join_cgroup_identity(const struct cgroup_mount *mount, const char *parent_realpath,
                                const char *invocation_name, const char *command_name,
                                char *identity, size_t capacity) {
  const char *relative = parent_realpath + strlen(mount->mountpoint);
  if (*relative == '/') {
    relative += 1u;
  }
  const char *root = mount->root;
  size_t root_length = strlen(root);
  while (root_length > 1u && root[root_length - 1u] == '/') {
    root_length -= 1u;
  }
  int length;
  if (relative[0] == '\0') {
    length = snprintf(identity, capacity, "%.*s%s%s/%s", (int)root_length, root,
                      root_length == 1u && root[0] == '/' ? "" : "/", invocation_name,
                      command_name);
  } else {
    length = snprintf(identity, capacity, "%.*s%s%s/%s/%s", (int)root_length, root,
                      root_length == 1u && root[0] == '/' ? "" : "/", relative,
                      invocation_name, command_name);
  }
  if (length <= 0 || (size_t)length >= capacity) {
    errno = ENAMETOOLONG;
    return -1;
  }
  return 0;
}

static int read_process_cgroup_identity(pid_t pid, char *identity, size_t capacity) {
  char path[64];
  int length = snprintf(path, sizeof(path), "/proc/%ld/cgroup", (long)pid);
  if (length <= 0 || (size_t)length >= sizeof(path)) {
    errno = ENAMETOOLONG;
    return -1;
  }
  int fd = open(path, O_RDONLY | O_CLOEXEC);
  if (fd < 0) {
    return -1;
  }
  char content[8192];
  int count = read_fd_text(fd, content, sizeof(content));
  int saved_errno = errno;
  close(fd);
  errno = saved_errno;
  if (count < 0) {
    return -1;
  }
  char *line = content;
  while (*line != '\0') {
    char *newline = strchr(line, '\n');
    if (newline != NULL) {
      *newline = '\0';
    }
    if (strncmp(line, "0::", 3u) == 0) {
      size_t identity_length = strlen(line + 3u);
      if (identity_length + 1u > capacity) {
        errno = ENAMETOOLONG;
        return -1;
      }
      memcpy(identity, line + 3u, identity_length + 1u);
      return 0;
    }
    if (newline == NULL) {
      break;
    }
    line = newline + 1u;
  }
  errno = EPROTO;
  return -1;
}

static int cgroup_procs_contains_only(int directory_fd, pid_t expected_pid) {
  char content[4096];
  if (read_file_at(directory_fd, "cgroup.procs", content, sizeof(content)) < 0) {
    return -1;
  }
  size_t members = 0u;
  bool found = false;
  char *save = NULL;
  for (char *line = strtok_r(content, "\n", &save); line != NULL;
       line = strtok_r(NULL, "\n", &save)) {
    char *end = NULL;
    errno = 0;
    long pid = strtol(line, &end, 10);
    if (errno != 0 || end == line || *end != '\0' || pid <= 0 || pid > INT_MAX) {
      errno = EPROTO;
      return -1;
    }
    members += 1u;
    if ((pid_t)pid == expected_pid) {
      found = true;
    }
  }
  if (!found || members != 1u) {
    errno = EPROTO;
    return -1;
  }
  return 0;
}

static int cgroup_write_pid(int procs_fd, pid_t pid) {
  char value[32];
  int length = snprintf(value, sizeof(value), "%ld", (long)pid);
  if (length <= 0 || (size_t)length >= sizeof(value)) {
    errno = EOVERFLOW;
    return -1;
  }
  return write_all(procs_fd, value, (size_t)length);
}

static int wait_cgroup_empty(int events_fd, int64_t deadline_ms) {
  while (true) {
    uint32_t populated = 1u;
    if (parse_cgroup_populated_fd(events_fd, &populated) < 0) {
      return -1;
    }
    if (populated == 0u) {
      return 0;
    }
    int64_t now = monotonic_ms();
    if (now < 0 || now >= deadline_ms) {
      errno = ETIMEDOUT;
      return -1;
    }
    int timeout = (int)(deadline_ms - now);
    if (timeout > GO_LIKE_E2E_INTERNAL_POLL_MS) {
      timeout = GO_LIKE_E2E_INTERNAL_POLL_MS;
    }
    struct pollfd poll_fd;
    poll_fd.fd = events_fd;
    poll_fd.events = POLLPRI | POLLERR;
    poll_fd.revents = 0;
    int result = poll(&poll_fd, 1u, timeout);
    if (result < 0 && errno != EINTR) {
      return -1;
    }
  }
}

static int cgroup_probe(struct cgroup_context *context,
                        const struct cgroup_mount *mount) {
  char probe_name[GO_LIKE_E2E_CGROUP_NAME_MAX];
  int name_length = snprintf(probe_name, sizeof(probe_name), "probe-%ld", (long)getpid());
  if (name_length <= 0 || (size_t)name_length >= sizeof(probe_name)) {
    errno = ENAMETOOLONG;
    return -1;
  }
  if (mkdirat(context->invocation_fd, probe_name, 0700) < 0) {
    return -1;
  }
  int probe_fd = openat(context->invocation_fd, probe_name,
                        O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
  if (probe_fd < 0) {
    int saved_errno = errno;
    (void)unlinkat(context->invocation_fd, probe_name, AT_REMOVEDIR);
    errno = saved_errno;
    return -1;
  }
  int procs_fd = openat(probe_fd, "cgroup.procs", O_WRONLY | O_CLOEXEC | O_NOFOLLOW);
  int kill_fd = openat(probe_fd, "cgroup.kill", O_WRONLY | O_CLOEXEC | O_NOFOLLOW);
  int events_fd = openat(probe_fd, "cgroup.events", O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
  if (procs_fd < 0 || kill_fd < 0 || events_fd < 0) {
    int saved_errno = errno;
    if (procs_fd >= 0) close(procs_fd);
    if (kill_fd >= 0) close(kill_fd);
    if (events_fd >= 0) close(events_fd);
    close(probe_fd);
    (void)unlinkat(context->invocation_fd, probe_name, AT_REMOVEDIR);
    errno = saved_errno;
    return -1;
  }
  uint32_t populated = 1u;
  if (parse_cgroup_populated_fd(events_fd, &populated) < 0 || populated != 0u) {
    int saved_errno = errno == 0 ? EPROTO : errno;
    close(procs_fd);
    close(kill_fd);
    close(events_fd);
    close(probe_fd);
    (void)unlinkat(context->invocation_fd, probe_name, AT_REMOVEDIR);
    errno = saved_errno;
    return -1;
  }

  pid_t probe_pid = fork();
  if (probe_pid < 0) {
    int saved_errno = errno;
    close(procs_fd);
    close(kill_fd);
    close(events_fd);
    close(probe_fd);
    (void)unlinkat(context->invocation_fd, probe_name, AT_REMOVEDIR);
    errno = saved_errno;
    return -1;
  }
  if (probe_pid == 0) {
    close(GO_LIKE_E2E_CONTROL_FD);
    close(GO_LIKE_E2E_RESPONSE_FD);
    close(GO_LIKE_E2E_TARGET_STDOUT_FD);
    close(GO_LIKE_E2E_TARGET_STDERR_FD);
    for (;;) {
      pause();
    }
  }
  int result = -1;
  int saved_errno = 0;
  if (cgroup_write_pid(procs_fd, probe_pid) < 0 ||
      cgroup_procs_contains_only(probe_fd, probe_pid) < 0) {
    saved_errno = errno;
    goto probe_cleanup;
  }
  char expected[GO_LIKE_E2E_MAX_CGROUP_IDENTITY_BYTES];
  char actual[GO_LIKE_E2E_MAX_CGROUP_IDENTITY_BYTES];
  if (join_cgroup_identity(mount, context->parent_realpath, context->invocation_name,
                           probe_name, expected, sizeof(expected)) < 0 ||
      read_process_cgroup_identity(probe_pid, actual, sizeof(actual)) < 0 ||
      strcmp(expected, actual) != 0) {
    saved_errno = errno == 0 ? EPROTO : errno;
    goto probe_cleanup;
  }
  if (write_all(kill_fd, "1", 1u) < 0) {
    saved_errno = errno;
    goto probe_cleanup;
  }
  if (wait_cgroup_empty(events_fd, monotonic_ms() + GO_LIKE_E2E_HARD_BUDGET_MS) < 0) {
    saved_errno = errno;
    goto probe_cleanup;
  }
  result = 0;

probe_cleanup:
  if (result < 0) {
    /* The probe is the controller's own child, never a foreign process. */
    if (cgroup_procs_contains_only(probe_fd, probe_pid) == 0) {
      (void)write_all(kill_fd, "1", 1u);
    } else {
      int pidfd = open_target_pidfd(probe_pid);
      if (pidfd >= 0) {
        (void)pidfd_send_signal_owned(pidfd, SIGKILL);
        close(pidfd);
      }
    }
  }
  int wait_status = 0;
  int64_t reap_deadline = monotonic_ms() + GO_LIKE_E2E_HARD_BUDGET_MS;
  if (waitpid_until(probe_pid, reap_deadline, &wait_status) < 0 && result == 0) {
    saved_errno = errno;
    result = -1;
  }
  close(procs_fd);
  close(kill_fd);
  close(events_fd);
  close(probe_fd);
  if (unlinkat(context->invocation_fd, probe_name, AT_REMOVEDIR) < 0 && result == 0) {
    saved_errno = errno;
    result = -1;
  }
  if (result < 0) {
    errno = saved_errno == 0 ? EIO : saved_errno;
  }
  return result;
}

static int cgroup_open_parent(struct cgroup_context *context, const char *configured_parent) {
  if (configured_parent == NULL || configured_parent[0] == '\0') {
    errno = ENOENT;
    return -1;
  }
  if (realpath(configured_parent, context->parent_realpath) == NULL) {
    return -1;
  }
  context->parent_fd = open(context->parent_realpath,
                            O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
  if (context->parent_fd < 0) {
    return -1;
  }
  char controllers[4096];
  char events[4096];
  if (read_file_at(context->parent_fd, "cgroup.controllers", controllers,
                   sizeof(controllers)) < 0 ||
      read_file_at(context->parent_fd, "cgroup.events", events, sizeof(events)) < 0 ||
      strstr(events, "populated ") == NULL) {
    return -1;
  }
  return 0;
}

static int cgroup_setup(struct controller *controller) {
  struct cgroup_context *context = &controller->cgroup;
  controller->cgroup_stage = CGROUP_STAGE_OPEN_PARENT;
  if (context->parent_fd < 0 &&
      cgroup_open_parent(context, controller->configured_cgroup_parent) < 0) {
    return -1;
  }
  controller->cgroup_stage = CGROUP_STAGE_NAME_PATHS;
  char nonce_hex[17];
  for (size_t index = 0u; index < 8u; index += 1u) {
    (void)snprintf(nonce_hex + index * 2u, 3u, "%02x", controller->nonce[index]);
  }
  int invocation_length =
      snprintf(context->invocation_name, sizeof(context->invocation_name),
               "go-like-%s-%ld", nonce_hex, (long)getpid());
  int command_length = snprintf(context->command_name, sizeof(context->command_name),
                                "command-1");
  if (invocation_length <= 0 ||
      (size_t)invocation_length >= sizeof(context->invocation_name) || command_length <= 0 ||
      (size_t)command_length >= sizeof(context->command_name)) {
    errno = ENAMETOOLONG;
    return -1;
  }
  controller->cgroup_stage = CGROUP_STAGE_CREATE_INVOCATION;
  if (mkdirat(context->parent_fd, context->invocation_name, 0700) < 0) {
    return -1;
  }
  context->invocation_created = true;
  controller->cgroup_stage = CGROUP_STAGE_OPEN_INVOCATION;
  context->invocation_fd =
      openat(context->parent_fd, context->invocation_name,
             O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
  if (context->invocation_fd < 0) {
    return -1;
  }
  controller->cgroup_stage = CGROUP_STAGE_VALIDATE_INVOCATION;
  struct stat invocation_stat;
  if (fstat(context->invocation_fd, &invocation_stat) < 0 ||
      !S_ISDIR(invocation_stat.st_mode)) {
    errno = EPROTO;
    return -1;
  }
  context->invocation_dev = invocation_stat.st_dev;
  context->invocation_ino = invocation_stat.st_ino;

  struct cgroup_mount mount;
  memset(&mount, 0, sizeof(mount));
  controller->cgroup_stage = CGROUP_STAGE_DISCOVER_MOUNT;
  if (find_cgroup2_mount(context->parent_realpath, &mount) < 0) {
    return -1;
  }
  controller->cgroup_stage = CGROUP_STAGE_PROBE;
  if (cgroup_probe(context, &mount) < 0) {
    return -1;
  }
  controller->cgroup_stage = CGROUP_STAGE_CREATE_COMMAND;
  if (mkdirat(context->invocation_fd, context->command_name, 0700) < 0) {
    return -1;
  }
  context->command_created = true;
  controller->cgroup_stage = CGROUP_STAGE_OPEN_COMMAND;
  context->command_fd =
      openat(context->invocation_fd, context->command_name,
             O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
  if (context->command_fd < 0) {
    return -1;
  }
  controller->cgroup_stage = CGROUP_STAGE_VALIDATE_COMMAND;
  struct stat command_stat;
  if (fstat(context->command_fd, &command_stat) < 0 || !S_ISDIR(command_stat.st_mode)) {
    errno = EPROTO;
    return -1;
  }
  context->command_dev = command_stat.st_dev;
  context->command_ino = command_stat.st_ino;
  controller->cgroup_stage = CGROUP_STAGE_OPEN_CONTROL_FILES;
  context->procs_fd =
      openat(context->command_fd, "cgroup.procs", O_WRONLY | O_CLOEXEC | O_NOFOLLOW);
  context->kill_fd =
      openat(context->command_fd, "cgroup.kill", O_WRONLY | O_CLOEXEC | O_NOFOLLOW);
  context->events_fd =
      openat(context->command_fd, "cgroup.events", O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
  if (context->procs_fd < 0 || context->kill_fd < 0 || context->events_fd < 0) {
    return -1;
  }
  controller->cgroup_stage = CGROUP_STAGE_VALIDATE_EMPTY_COMMAND;
  uint32_t populated = 1u;
  if (parse_cgroup_populated_fd(context->events_fd, &populated) < 0 || populated != 0u ||
      join_cgroup_identity(&mount, context->parent_realpath, context->invocation_name,
                           context->command_name, context->expected_identity,
                           sizeof(context->expected_identity)) < 0) {
    errno = errno == 0 ? EPROTO : errno;
    return -1;
  }
  controller->cgroup_stage = CGROUP_STAGE_READY;
  return 0;
}

static int cgroup_validate_anchor(const struct controller *controller) {
  const struct cgroup_context *context = &controller->cgroup;
  if (cgroup_procs_contains_only(context->command_fd, controller->anchor_pid) < 0) {
    return -1;
  }
  char actual[GO_LIKE_E2E_MAX_CGROUP_IDENTITY_BYTES];
  if (read_process_cgroup_identity(controller->anchor_pid, actual, sizeof(actual)) < 0 ||
      strcmp(actual, context->expected_identity) != 0) {
    errno = errno == 0 ? EPROTO : errno;
    return -1;
  }
  return 0;
}

static int cgroup_revalidate_dirfd(const struct cgroup_context *context) {
  struct stat invocation_stat;
  struct stat command_stat;
  int invocation_check =
      openat(context->parent_fd, context->invocation_name,
             O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
  if (invocation_check < 0) {
    return -1;
  }
  int command_check =
      openat(context->invocation_fd, context->command_name,
             O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
  if (command_check < 0) {
    int saved_errno = errno;
    close(invocation_check);
    errno = saved_errno;
    return -1;
  }
  int result = 0;
  if (fstat(invocation_check, &invocation_stat) < 0 ||
      fstat(command_check, &command_stat) < 0 ||
      invocation_stat.st_dev != context->invocation_dev ||
      invocation_stat.st_ino != context->invocation_ino ||
      command_stat.st_dev != context->command_dev ||
      command_stat.st_ino != context->command_ino) {
    errno = EPROTO;
    result = -1;
  }
  close(invocation_check);
  close(command_check);
  return result;
}

static int cgroup_remove_tree(struct cgroup_context *context) {
  int result = 0;
  int saved_errno = 0;
  if (context->procs_fd >= 0) {
    close(context->procs_fd);
    context->procs_fd = -1;
  }
  if (context->kill_fd >= 0) {
    close(context->kill_fd);
    context->kill_fd = -1;
  }
  if (context->events_fd >= 0) {
    close(context->events_fd);
    context->events_fd = -1;
  }
  if (context->command_fd >= 0) {
    close(context->command_fd);
    context->command_fd = -1;
  }
  if (context->command_created &&
      unlinkat(context->invocation_fd, context->command_name, AT_REMOVEDIR) < 0) {
    result = -1;
    saved_errno = errno;
  } else {
    context->command_created = false;
  }
  if (context->invocation_fd >= 0) {
    close(context->invocation_fd);
    context->invocation_fd = -1;
  }
  if (context->invocation_created &&
      unlinkat(context->parent_fd, context->invocation_name, AT_REMOVEDIR) < 0) {
    if (result == 0) {
      result = -1;
      saved_errno = errno;
    }
  } else {
    context->invocation_created = false;
  }
  if (result < 0) {
    errno = saved_errno;
  }
  return result;
}

static int open_target_pidfd(pid_t pid) {
#ifdef SYS_pidfd_open
  return (int)syscall(SYS_pidfd_open, pid, 0u);
#else
  (void)pid;
  errno = ENOSYS;
  return -1;
#endif
}

static int pidfd_send_signal_owned(int pidfd, int signal_number) {
#ifdef SYS_pidfd_send_signal
  return (int)syscall(SYS_pidfd_send_signal, pidfd, signal_number, NULL, 0u);
#else
  (void)pidfd;
  (void)signal_number;
  errno = ENOSYS;
  return -1;
#endif
}
#endif

static int validate_anchor_authorization(const struct controller *controller,
                                         bool allow_exited_unreaped) {
  if (controller->anchor_pid <= 0 || getpgrp() == controller->anchor_pid ||
      getsid(0) == controller->anchor_pid || controller->anchor_event_eof) {
    errno = EPERM;
    return -1;
  }
  siginfo_t information;
  memset(&information, 0, sizeof(information));
  if (waitid(P_PID, (id_t)controller->anchor_pid, &information,
             WEXITED | WNOHANG | WNOWAIT) < 0) {
    return -1;
  }
  bool exited = information.si_pid == controller->anchor_pid;
  if (exited && !allow_exited_unreaped) {
    errno = ECHILD;
    return -1;
  }
  if (!exited) {
    struct pollfd status_pipe;
    status_pipe.fd = controller->anchor_event_fd;
    status_pipe.events = POLLHUP | POLLERR;
    status_pipe.revents = 0;
    if (controller->anchor_event_fd < 0 || poll(&status_pipe, 1u, 0) < 0 ||
        (status_pipe.revents & (POLLHUP | POLLERR)) != 0) {
      errno = EPIPE;
      return -1;
    }
  }
  if (getpgid(controller->anchor_pid) != controller->anchor_pid ||
      getsid(controller->anchor_pid) != controller->anchor_pid) {
    errno = EPERM;
    return -1;
  }
  return 0;
}

#if defined(GO_LIKE_E2E_TEST_HOOKS)
static bool test_force_inconclusive(const struct controller *controller) {
  const char *value = target_environment_value(
      &controller->target, "GO_LIKE_E2E_TEST_FORCE_INCONCLUSIVE");
  return value != NULL && strcmp(value, "1") == 0;
}

static uint32_t test_skip_kill_rounds(const struct controller *controller) {
  const char *value = target_environment_value(&controller->target,
                                                "GO_LIKE_E2E_TEST_SKIP_KILL_ROUNDS");
  if (value == NULL) {
    return 0u;
  }
  if (strcmp(value, "1") == 0) {
    return 1u;
  }
  if (strcmp(value, "2") == 0) {
    return 2u;
  }
  if (strcmp(value, "3") == 0) {
    return 3u;
  }
  return 0u;
}

static int test_signal_barrier(const struct controller *controller, const char *stage,
                               int64_t deadline_ms) {
  const char *directory = target_environment_value(
      &controller->target, "GO_LIKE_E2E_TEST_SIGNAL_BARRIER_DIR");
  if (directory == NULL || directory[0] != '/') {
    return 0;
  }
  char ready_path[PATH_MAX];
  char release_path[PATH_MAX];
  int ready_length =
      snprintf(ready_path, sizeof(ready_path), "%s/%s.ready", directory, stage);
  int release_length =
      snprintf(release_path, sizeof(release_path), "%s/%s.release", directory, stage);
  if (ready_length <= 0 || (size_t)ready_length >= sizeof(ready_path) ||
      release_length <= 0 || (size_t)release_length >= sizeof(release_path)) {
    errno = ENAMETOOLONG;
    return -1;
  }
  int ready_fd = open(ready_path, O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC, 0600);
  if (ready_fd < 0) {
    return -1;
  }
  int close_result = close(ready_fd);
  if (close_result < 0) {
    return -1;
  }
  while (access(release_path, F_OK) < 0) {
    if (errno != ENOENT) {
      return -1;
    }
    int64_t now = monotonic_ms();
    if (now < 0 || now >= deadline_ms) {
      errno = ETIMEDOUT;
      return -1;
    }
    sleep_until_or_for(deadline_ms, GO_LIKE_E2E_INTERNAL_POLL_MS);
  }
  return 0;
}
#else
static bool test_force_inconclusive(const struct controller *controller) {
  (void)controller;
  return false;
}

static uint32_t test_skip_kill_rounds(const struct controller *controller) {
  (void)controller;
  return 0u;
}

static int test_signal_barrier(const struct controller *controller, const char *stage,
                               int64_t deadline_ms) {
  (void)controller;
  (void)stage;
  (void)deadline_ms;
  return 0;
}
#endif

static int send_anchored_group_signal(const struct controller *controller, int signal_number,
                                      bool allow_exited_unreaped, const char *test_stage,
                                      bool test_skip_signal, int64_t deadline_ms) {
  if (validate_anchor_authorization(controller, allow_exited_unreaped) < 0) {
    return -1;
  }
  if (test_signal_barrier(controller, test_stage, deadline_ms) < 0) {
    return -1;
  }
  if (test_skip_signal) {
    return 0;
  }
  return kill(-controller->anchor_pid, signal_number);
}

static int waitpid_until(pid_t pid, int64_t deadline_ms, int *wait_status) {
  while (true) {
    pid_t waited = waitpid(pid, wait_status, WNOHANG);
    if (waited == pid) {
      return 0;
    }
    if (waited < 0) {
      if (errno == EINTR) {
        continue;
      }
      return -1;
    }
    int64_t now = monotonic_ms();
    if (now < 0 || now >= deadline_ms) {
      errno = ETIMEDOUT;
      return -1;
    }
    sleep_until_or_for(deadline_ms, GO_LIKE_E2E_INTERNAL_POLL_MS);
  }
}

static int send_target_exit_event(struct controller *controller) {
  struct byte_buffer payload = {0};
  int result = -1;
  if (byte_buffer_append_u32(&payload, controller->target_status.exit_kind) < 0 ||
      byte_buffer_append_i32(&payload, controller->target_status.exit_value) < 0 ||
      byte_buffer_append_u32(&payload, controller->target_status.core_dumped) < 0) {
    goto done;
  }
  result = send_frame(controller, GO_LIKE_E2E_RESPONSE_TARGET_EXIT,
                      GO_LIKE_E2E_RESPONSE_FLAG_EVENT, controller->start_request_id,
                      payload.data, payload.length);
done:
  byte_buffer_free(&payload);
  return result;
}

static int handle_anchor_event(struct controller *controller,
                               const struct anchor_event *event) {
  if (event->kind == ANCHOR_EVENT_ERROR) {
    errno = event->value == 0 ? EIO : event->value;
    return -1;
  }
  if (event->kind == ANCHOR_EVENT_READY) {
    if (!controller->prepare_pending || event->pid != (uint32_t)controller->anchor_pid ||
        getpgid(controller->anchor_pid) != controller->anchor_pid ||
        getsid(controller->anchor_pid) != controller->anchor_pid ||
        record_anchor_identity(controller) < 0) {
      errno = errno == 0 ? EPROTO : errno;
      return -1;
    }
#if defined(__linux__)
    if (controller->mode == GO_LIKE_E2E_MODE_LINUX_CGROUP_V2_STRICT &&
        cgroup_validate_anchor(controller) < 0) {
      return -1;
    }
#endif
    struct byte_buffer payload = {0};
    size_t identity_length = 0u;
#if defined(__linux__)
    const char *identity = "";
    if (controller->mode == GO_LIKE_E2E_MODE_LINUX_CGROUP_V2_STRICT) {
      identity = controller->cgroup.expected_identity;
      identity_length = strlen(identity);
    }
#else
    const char *identity = "";
#endif
    int result = -1;
    if (byte_buffer_append_u32(&payload, (uint32_t)controller->mode) < 0 ||
        byte_buffer_append_u32(&payload, (uint32_t)controller->anchor_pid) < 0 ||
        byte_buffer_append_u32(&payload, (uint32_t)controller->anchor_pid) < 0 ||
        byte_buffer_append_u32(&payload, (uint32_t)controller->anchor_pid) < 0 ||
        byte_buffer_append_u32(&payload, (uint32_t)identity_length) < 0 ||
        byte_buffer_append(&payload, identity, identity_length) < 0) {
      byte_buffer_free(&payload);
      return -1;
    }
    result = send_frame(controller, GO_LIKE_E2E_RESPONSE_ANCHOR_READY, 0u,
                        controller->prepare_request_id, payload.data, payload.length);
    byte_buffer_free(&payload);
    if (result < 0) {
      return -1;
    }
    controller->prepare_pending = false;
    controller->state = GO_LIKE_E2E_STATE_ANCHOR_READY;
    return 0;
  }
  if (event->kind == ANCHOR_EVENT_TARGET_STARTED) {
    if (!controller->start_pending || event->pid == 0u) {
      errno = EPROTO;
      return -1;
    }
    controller->target_pid = (pid_t)event->pid;
#if defined(__linux__)
    controller->target_pidfd = open_target_pidfd(controller->target_pid);
#else
    controller->target_pidfd = -1;
#endif
    struct byte_buffer payload = {0};
    int result = -1;
    if (byte_buffer_append_u32(&payload, event->pid) < 0 ||
        byte_buffer_append_u32(&payload, controller->target_pidfd >= 0 ? 1u : 0u) < 0) {
      byte_buffer_free(&payload);
      return -1;
    }
    result = send_frame(controller, GO_LIKE_E2E_RESPONSE_TARGET_STARTED, 0u,
                        controller->start_request_id, payload.data, payload.length);
    byte_buffer_free(&payload);
    if (result < 0) {
      return -1;
    }
    controller->start_pending = false;
    controller->state = GO_LIKE_E2E_STATE_RUNNING;
    (void)refresh_tracker(controller);
    return 0;
  }
  if (event->kind == ANCHOR_EVENT_TARGET_EXIT) {
    controller->target_pid = (pid_t)event->pid;
    controller->target_status.known = true;
    controller->target_status.exit_kind = event->auxiliary & 0xffffu;
    controller->target_status.core_dumped = (event->auxiliary >> 16u) & 1u;
    controller->target_status.exit_value = event->value;
    controller->start_pending = false;
    controller->state = GO_LIKE_E2E_STATE_TARGET_EXITED;
    (void)refresh_tracker(controller);
    return send_target_exit_event(controller);
  }
  errno = EPROTO;
  return -1;
}

static int drain_anchor_events(struct controller *controller) {
  if (controller->anchor_event_fd < 0 || controller->anchor_event_eof) {
    return 0;
  }
  while (true) {
    size_t available = sizeof(controller->anchor_input) - controller->anchor_input_length;
    if (available == 0u) {
      errno = EOVERFLOW;
      return -1;
    }
    ssize_t count = read(controller->anchor_event_fd,
                         controller->anchor_input + controller->anchor_input_length,
                         available);
    if (count > 0) {
      controller->anchor_input_length += (size_t)count;
      while (controller->anchor_input_length >= sizeof(struct anchor_event)) {
        struct anchor_event event;
        memcpy(&event, controller->anchor_input, sizeof(event));
        memmove(controller->anchor_input,
                controller->anchor_input + sizeof(struct anchor_event),
                controller->anchor_input_length - sizeof(struct anchor_event));
        controller->anchor_input_length -= sizeof(struct anchor_event);
        if (handle_anchor_event(controller, &event) < 0) {
          return -1;
        }
      }
      continue;
    }
    if (count == 0) {
      controller->anchor_event_eof = true;
      if (controller->anchor_input_length != 0u) {
        errno = EPROTO;
        return -1;
      }
      return 0;
    }
    if (errno == EINTR) {
      continue;
    }
    if (errno == EAGAIN || errno == EWOULDBLOCK) {
      return 0;
    }
    return -1;
  }
}

static int start_anchor(struct controller *controller) {
  int control_pipe[2];
  int event_pipe[2];
  if (socketpair(AF_UNIX, SOCK_STREAM, 0, control_pipe) < 0) {
    return -1;
  }
  if (set_cloexec(control_pipe[0]) < 0 || set_cloexec(control_pipe[1]) < 0) {
    int saved_errno = errno;
    close(control_pipe[0]);
    close(control_pipe[1]);
    errno = saved_errno;
    return -1;
  }
  if (make_pipe_cloexec(event_pipe) < 0) {
    int saved_errno = errno;
    close(control_pipe[0]);
    close(control_pipe[1]);
    errno = saved_errno;
    return -1;
  }
  pid_t anchor_pid = fork();
  if (anchor_pid < 0) {
    int saved_errno = errno;
    close(control_pipe[0]);
    close(control_pipe[1]);
    close(event_pipe[0]);
    close(event_pipe[1]);
    errno = saved_errno;
    return -1;
  }
  if (anchor_pid == 0) {
    close(control_pipe[1]);
    close(event_pipe[0]);
#if defined(__linux__)
    int cgroup_procs_fd = controller->mode == GO_LIKE_E2E_MODE_LINUX_CGROUP_V2_STRICT
                              ? controller->cgroup.procs_fd
                              : -1;
#else
    int cgroup_procs_fd = -1;
#endif
    anchor_process(&controller->target, controller->mode, control_pipe[0], event_pipe[1],
                   cgroup_procs_fd);
  }
  close(control_pipe[0]);
  close(event_pipe[1]);
  controller->anchor_pid = anchor_pid;
  controller->anchor_control_fd = control_pipe[1];
  controller->anchor_event_fd = event_pipe[0];
  if (set_nonblocking(controller->anchor_event_fd) < 0) {
    return -1;
  }
  close(GO_LIKE_E2E_TARGET_STDOUT_FD);
  close(GO_LIKE_E2E_TARGET_STDERR_FD);
  return 0;
}

static int reap_anchor_at_final_observation(struct controller *controller,
                                            int64_t deadline_ms) {
  if (controller->anchor_pid <= 0) {
    return 0;
  }
  int wait_status = 0;
  if (waitpid_until(controller->anchor_pid, deadline_ms, &wait_status) < 0) {
    return -1;
  }
  controller->anchor_pid = -1;
  return 0;
}

static int finalize_anchored(struct controller *controller, bool include_term_phase,
                             struct observation *observation,
                             enum go_like_e2e_cleanup_result *cleanup_result,
                             const char **detail) {
  int64_t started = monotonic_ms();
  if (started < 0) {
    return -1;
  }
  int64_t deadline = started + GO_LIKE_E2E_HARD_BUDGET_MS;
  memset(observation, 0, sizeof(*observation));
  *cleanup_result = GO_LIKE_E2E_CLEANUP_INCONCLUSIVE;
  *detail = "anchored cleanup did not establish a final observation";

  bool cleanup_required = true;
  if (drain_anchor_events(controller) == 0 &&
      observe_managed_processes(controller, observation) == 0) {
    cleanup_required = observation->same_group_live > 0u ||
                       observation->breakaway_live > 0u;
  } else {
    controller->tracker_inconclusive = true;
  }

  uint32_t skip_kill_rounds = test_skip_kill_rounds(controller);
  if (cleanup_required && include_term_phase) {
    if (send_anchored_group_signal(controller, SIGTERM, false, "term", false, deadline) < 0) {
      *detail = "live anchor authorization failed before TERM";
      return 0;
    }
    controller->term_sent = true;
    sleep_until_or_for(deadline, GO_LIKE_E2E_TERM_GRACE_MS);
    if (drain_anchor_events(controller) < 0 ||
        observe_managed_processes(controller, observation) < 0) {
      *detail = "fresh process observation failed after TERM";
      return 0;
    }
  }

  while (observation->same_group_live > 0u &&
         controller->kill_rounds < GO_LIKE_E2E_MACOS_MAX_KILL_ROUNDS &&
         monotonic_ms() < deadline) {
    bool allow_exited_anchor = controller->kill_rounds > 0u;
    uint32_t next_kill_round = controller->kill_rounds + 1u;
    char test_stage[16];
    int stage_length =
        snprintf(test_stage, sizeof(test_stage), "kill-%u", next_kill_round);
    bool skip_signal = next_kill_round <= skip_kill_rounds;
    if (stage_length <= 0 || (size_t)stage_length >= sizeof(test_stage) ||
        send_anchored_group_signal(controller, SIGKILL,
                                   allow_exited_anchor && !skip_signal, test_stage,
                                   skip_signal, deadline) < 0) {
      *detail = "anchor authorization or test barrier failed before KILL";
      return 0;
    }
    controller->kill_rounds = next_kill_round;
    sleep_until_or_for(deadline, GO_LIKE_E2E_KILL_ROUND_WAIT_MS);
    if (drain_anchor_events(controller) < 0 ||
        observe_managed_processes(controller, observation) < 0) {
      *detail = "fresh process observation failed after KILL";
      return 0;
    }
  }

  if (observe_managed_processes(controller, observation) < 0) {
    *detail = "final fresh process observation failed";
    return 0;
  }
  if (controller->tracker_inconclusive || test_force_inconclusive(controller)) {
    *detail = "descendant tracking was incomplete before the final observation";
    return 0;
  }
  if (controller->kill_rounds == 0u) {
    if (controller_send_anchor_command(controller, ANCHOR_COMMAND_EXIT) < 0) {
      *detail = "anchor exit request failed after final observation";
      return 0;
    }
  }
  controller_close_anchor_control(controller);
  if (reap_anchor_at_final_observation(controller, deadline) < 0) {
    *detail = "anchor did not reap within the hard cleanup budget";
    return 0;
  }
  if (observation->same_group_live > 0u || observation->breakaway_live > 0u) {
    *cleanup_result = GO_LIKE_E2E_CLEANUP_RESIDUAL_PRESENT;
    *detail = observation->breakaway_live > 0u
                  ? "breakaway descendants were observed and were not numerically signaled"
                  : "same-group survivors remained after bounded anchored cleanup";
    return 0;
  }
  *cleanup_result = GO_LIKE_E2E_CLEANUP_ZERO_OBSERVED;
  *detail = "no live non-anchor member was observed after the bounded attempt";
  return 0;
}

#if defined(__linux__)
static void reap_linux_managed_children(struct controller *controller) {
  while (true) {
    int wait_status = 0;
    pid_t pid = waitpid(-1, &wait_status, WNOHANG | __WALL);
    if (pid <= 0) {
      return;
    }
    if (pid == controller->anchor_pid) {
      controller->anchor_pid = -1;
    }
    if (pid == controller->target_pid && !controller->target_status.known) {
      status_from_wait_status(wait_status, &controller->target_status);
    }
  }
}

static int finalize_strict_cgroup(struct controller *controller,
                                  enum go_like_e2e_cleanup_result *cleanup_result,
                                  uint32_t *cgroup_populated, const char **detail) {
  int64_t started = monotonic_ms();
  if (started < 0) {
    return -1;
  }
  int64_t deadline = started + GO_LIKE_E2E_HARD_BUDGET_MS;
  *cleanup_result = GO_LIKE_E2E_CLEANUP_PLATFORM_FAILURE;
  *cgroup_populated = 1u;
  *detail = "strict cgroup cleanup failed";
  if (cgroup_revalidate_dirfd(&controller->cgroup) < 0) {
    *detail = "strict cgroup identity revalidation failed";
    return -1;
  }
  controller_close_anchor_control(controller);
  if (write_all(controller->cgroup.kill_fd, "1", 1u) < 0) {
    *detail = "cgroup.kill write failed; no PID or PGID fallback was attempted";
    return -1;
  }
  while (true) {
    reap_linux_managed_children(controller);
    (void)drain_anchor_events(controller);
    if (parse_cgroup_populated_fd(controller->cgroup.events_fd, cgroup_populated) < 0) {
      *detail = "cgroup.events read failed after cgroup.kill";
      return -1;
    }
    if (*cgroup_populated == 0u) {
      break;
    }
    int64_t now = monotonic_ms();
    if (now < 0 || now >= deadline) {
      errno = ETIMEDOUT;
      *detail = "cgroup.events did not reach populated 0 within the hard budget";
      return -1;
    }
    sleep_until_or_for(deadline, GO_LIKE_E2E_INTERNAL_POLL_MS);
  }
  reap_linux_managed_children(controller);
  if (controller->anchor_pid > 0) {
    int wait_status = 0;
    if (waitpid_until(controller->anchor_pid, deadline, &wait_status) < 0 && errno != ECHILD) {
      *detail = "managed anchor was not reaped after cgroup populated 0";
      return -1;
    }
    controller->anchor_pid = -1;
  }
  reap_linux_managed_children(controller);
  if (drain_anchor_events(controller) < 0) {
    *detail = "anchor status pipe did not drain after cgroup populated 0";
    return -1;
  }
  if (cgroup_remove_tree(&controller->cgroup) < 0) {
    *detail = "dirfd-relative cgroup leaf removal failed";
    return -1;
  }
  *cleanup_result = GO_LIKE_E2E_CLEANUP_ZERO_OBSERVED;
  *detail = "cgroup.events reached populated 0 and invocation leaves were removed";
  return 0;
}
#endif

static int send_finalized(struct controller *controller, uint64_t request_id,
                          enum go_like_e2e_cleanup_result cleanup_result,
                          const struct observation *observation, uint32_t cgroup_populated,
                          const char *detail) {
  struct byte_buffer payload = {0};
  size_t detail_length = strlen(detail);
  if (detail_length > GO_LIKE_E2E_ERROR_MESSAGE_MAX) {
    detail_length = GO_LIKE_E2E_ERROR_MESSAGE_MAX;
  }
  int result = -1;
  if (byte_buffer_append_u32(&payload, (uint32_t)cleanup_result) < 0 ||
      byte_buffer_append_u32(&payload, controller->term_sent ? 1u : 0u) < 0 ||
      byte_buffer_append_u32(&payload, controller->kill_rounds) < 0 ||
      byte_buffer_append_u32(&payload, observation->same_group_live) < 0 ||
      byte_buffer_append_u32(&payload, observation->breakaway_live) < 0 ||
      byte_buffer_append_u32(&payload, cgroup_populated) < 0 ||
      byte_buffer_append_u32(&payload, controller->target_status.known ? 1u : 0u) < 0 ||
      byte_buffer_append_u32(&payload, controller->target_status.exit_kind) < 0 ||
      byte_buffer_append_i32(&payload, controller->target_status.exit_value) < 0 ||
      byte_buffer_append_u32(&payload, (uint32_t)detail_length) < 0 ||
      byte_buffer_append(&payload, detail, detail_length) < 0) {
    goto done;
  }
  result = send_frame(controller, GO_LIKE_E2E_RESPONSE_FINALIZED, 0u, request_id,
                      payload.data, payload.length);
done:
  byte_buffer_free(&payload);
  return result;
}

static int finalize_controller(struct controller *controller, uint64_t request_id,
                               bool send_response, bool include_term_phase) {
  struct observation observation;
  memset(&observation, 0, sizeof(observation));
  enum go_like_e2e_cleanup_result cleanup_result = GO_LIKE_E2E_CLEANUP_INCONCLUSIVE;
  uint32_t cgroup_populated = GO_LIKE_E2E_CGROUP_POPULATED_NA;
  const char *detail = "cleanup was not attempted";
  int result = 0;
  int saved_errno = 0;
#if defined(__linux__)
  if (controller->mode == GO_LIKE_E2E_MODE_LINUX_CGROUP_V2_STRICT) {
    result = finalize_strict_cgroup(controller, &cleanup_result, &cgroup_populated, &detail);
    saved_errno = errno;
  } else
#endif
  {
    result = finalize_anchored(controller, include_term_phase, &observation,
                               &cleanup_result, &detail);
    saved_errno = errno;
  }
  controller->state = result == 0 ? GO_LIKE_E2E_STATE_FINALIZED : GO_LIKE_E2E_STATE_FAILED;
  if (send_response) {
    if (result < 0) {
      (void)send_error(controller, request_id,
#if defined(__linux__)
                       controller->mode == GO_LIKE_E2E_MODE_LINUX_CGROUP_V2_STRICT
                           ? GO_LIKE_E2E_ERROR_CGROUP_OPERATION
                           : GO_LIKE_E2E_ERROR_OBSERVATION,
#else
                       GO_LIKE_E2E_ERROR_OBSERVATION,
#endif
                       saved_errno, true, detail);
    } else if (send_finalized(controller, request_id, cleanup_result, &observation,
                              cgroup_populated, detail) < 0) {
      return -1;
    }
  }
  errno = saved_errno;
  return result;
}

static int send_query(struct controller *controller, uint64_t request_id) {
  struct observation observation;
  memset(&observation, 0, sizeof(observation));
  uint32_t cgroup_populated = GO_LIKE_E2E_CGROUP_POPULATED_NA;
  if (controller->anchor_pid > 0 &&
      controller->mode == GO_LIKE_E2E_MODE_ANCHORED_MANAGED &&
      observe_managed_processes(controller, &observation) < 0) {
    return send_error(controller, request_id, GO_LIKE_E2E_ERROR_OBSERVATION, errno, false,
                      "fresh process observation failed");
  }
#if defined(__linux__)
  if (controller->mode == GO_LIKE_E2E_MODE_LINUX_CGROUP_V2_STRICT &&
      controller->cgroup.events_fd >= 0 &&
      parse_cgroup_populated_fd(controller->cgroup.events_fd, &cgroup_populated) < 0) {
    return send_error(controller, request_id, GO_LIKE_E2E_ERROR_CGROUP_OPERATION, errno,
                      false, "cgroup.events query failed");
  }
#endif
  struct byte_buffer payload = {0};
  int result = -1;
  if (byte_buffer_append_u32(&payload, (uint32_t)controller->state) < 0 ||
      byte_buffer_append_u32(&payload, (uint32_t)controller->mode) < 0 ||
      byte_buffer_append_u32(&payload,
                             controller->anchor_pid > 0 ? (uint32_t)controller->anchor_pid : 0u) < 0 ||
      byte_buffer_append_u32(&payload,
                             controller->target_pid > 0 ? (uint32_t)controller->target_pid : 0u) < 0 ||
      byte_buffer_append_u32(&payload, controller->target_status.known ? 1u : 0u) < 0 ||
      byte_buffer_append_u32(&payload, controller->target_status.exit_kind) < 0 ||
      byte_buffer_append_i32(&payload, controller->target_status.exit_value) < 0 ||
      byte_buffer_append_u32(&payload, observation.same_group_live) < 0 ||
      byte_buffer_append_u32(&payload, observation.breakaway_live) < 0 ||
      byte_buffer_append_u32(&payload, cgroup_populated) < 0) {
    goto done;
  }
  result = send_frame(controller, GO_LIKE_E2E_RESPONSE_QUERY, 0u, request_id,
                      payload.data, payload.length);
done:
  byte_buffer_free(&payload);
  return result;
}

static int handle_prepare_request(struct controller *controller,
                                  const struct request_frame *frame) {
  if (controller->state != GO_LIKE_E2E_STATE_READY || controller->prepare_pending ||
      frame->payload_length == 0u) {
    errno = EPROTO;
    return -1;
  }
  struct target_spec target;
  memset(&target, 0, sizeof(target));
  enum go_like_e2e_process_mode mode;
  if (parse_prepare_payload(frame->payload, frame->payload_length, &mode, &target) < 0) {
    return -1;
  }
#if defined(__APPLE__)
  if (mode == GO_LIKE_E2E_MODE_LINUX_CGROUP_V2_STRICT) {
    target_spec_free(&target);
    errno = ENOTSUP;
    return -1;
  }
#elif defined(__linux__)
  if (mode == GO_LIKE_E2E_MODE_LINUX_CGROUP_V2_STRICT &&
      cgroup_setup(controller) < 0) {
    int setup_errno = errno;
    (void)cgroup_remove_tree(&controller->cgroup);
    target_spec_free(&target);
    errno = setup_errno;
    return -1;
  }
#endif
  controller->mode = mode;
  controller->target = target;
  controller->prepare_request_id = frame->request_id;
  controller->prepare_pending = true;
  if (start_anchor(controller) < 0) {
    return -1;
  }
  return 0;
}

static int handle_start_request(struct controller *controller,
                                const struct request_frame *frame) {
  if (controller->state != GO_LIKE_E2E_STATE_ANCHOR_READY || controller->start_pending ||
      frame->payload_length != 0u) {
    errno = EPROTO;
    return -1;
  }
  controller->start_request_id = frame->request_id;
  controller->start_pending = true;
  if (controller_send_anchor_command(controller, ANCHOR_COMMAND_START) < 0) {
    return -1;
  }
  return 0;
}

static int handle_direct_signal_request(struct controller *controller,
                                        const struct request_frame *frame) {
  if (controller->state != GO_LIKE_E2E_STATE_RUNNING || frame->payload_length != 4u) {
    errno = EPROTO;
    return -1;
  }
  uint32_t signal_number = load_u32_be(frame->payload);
  if (signal_number == 0u || signal_number >= NSIG) {
    errno = EINVAL;
    return -1;
  }
#if defined(__linux__)
  if (controller->target_pidfd < 0) {
    return send_error(controller, frame->request_id, GO_LIKE_E2E_ERROR_PIDFD_UNAVAILABLE,
                      ENOSYS, false,
                      "direct identity-safe signal requires an acquired pidfd");
  }
  if (pidfd_send_signal_owned(controller->target_pidfd, (int)signal_number) < 0) {
    return send_error(controller, frame->request_id, GO_LIKE_E2E_ERROR_DIRECT_SIGNAL,
                      errno, false, "pidfd_send_signal failed");
  }
  uint8_t payload[4];
  store_u32_be(payload, signal_number);
  return send_frame(controller, GO_LIKE_E2E_RESPONSE_DIRECT_SIGNAL_SENT, 0u,
                    frame->request_id, payload, sizeof(payload));
#else
  return send_error(controller, frame->request_id, GO_LIKE_E2E_ERROR_PLATFORM_UNSUPPORTED,
                    ENOTSUP, false, "macOS does not provide pidfd direct signaling");
#endif
}

static bool known_request_type(uint16_t type) {
  switch (type) {
    case GO_LIKE_E2E_REQUEST_PREPARE:
    case GO_LIKE_E2E_REQUEST_START:
    case GO_LIKE_E2E_REQUEST_FINALIZE:
    case GO_LIKE_E2E_REQUEST_TERMINATE:
    case GO_LIKE_E2E_REQUEST_QUERY:
    case GO_LIKE_E2E_REQUEST_DIRECT_SIGNAL:
    case GO_LIKE_E2E_REQUEST_CLOSE:
    case GO_LIKE_E2E_REQUEST_HARD_TERMINATE:
      return true;
    default:
      return false;
  }
}

static int dispatch_request(struct controller *controller,
                            const struct request_frame *frame) {
  if (frame->flags != 0u || frame->request_id == 0u) {
    errno = EPROTO;
    return -1;
  }
  if (!nonce_equal(frame->nonce, controller->nonce)) {
    errno = EACCES;
    return -2;
  }
  if (frame->request_id <= controller->last_request_id) {
    errno = EALREADY;
    return -3;
  }
  controller->last_request_id = frame->request_id;
  if (!known_request_type(frame->type)) {
    errno = ENOTSUP;
    return -4;
  }
  switch (frame->type) {
    case GO_LIKE_E2E_REQUEST_PREPARE:
      return handle_prepare_request(controller, frame);
    case GO_LIKE_E2E_REQUEST_START:
      return handle_start_request(controller, frame);
    case GO_LIKE_E2E_REQUEST_FINALIZE:
    case GO_LIKE_E2E_REQUEST_TERMINATE:
    case GO_LIKE_E2E_REQUEST_HARD_TERMINATE:
      if ((controller->state != GO_LIKE_E2E_STATE_ANCHOR_READY &&
           controller->state != GO_LIKE_E2E_STATE_RUNNING &&
           controller->state != GO_LIKE_E2E_STATE_TARGET_EXITED) ||
          frame->payload_length != 0u) {
        errno = EPROTO;
        return -1;
      }
      return finalize_controller(controller, frame->request_id, true,
                                 frame->type != GO_LIKE_E2E_REQUEST_HARD_TERMINATE);
    case GO_LIKE_E2E_REQUEST_QUERY:
      if (frame->payload_length != 0u) {
        errno = EPROTO;
        return -1;
      }
      return send_query(controller, frame->request_id);
    case GO_LIKE_E2E_REQUEST_DIRECT_SIGNAL:
      return handle_direct_signal_request(controller, frame);
    case GO_LIKE_E2E_REQUEST_CLOSE:
      if (frame->payload_length != 0u ||
          (controller->state != GO_LIKE_E2E_STATE_READY &&
           controller->state != GO_LIKE_E2E_STATE_FINALIZED)) {
        errno = EPROTO;
        return -1;
      }
      if (send_frame(controller, GO_LIKE_E2E_RESPONSE_CLOSED, 0u, frame->request_id, NULL,
                     0u) < 0) {
        return -1;
      }
      controller->state = GO_LIKE_E2E_STATE_CLOSED;
      return 0;
    default:
      errno = ENOTSUP;
      return -4;
  }
}

static void controller_close_fds(struct controller *controller) {
  if (controller->target_pidfd >= 0) {
    close(controller->target_pidfd);
    controller->target_pidfd = -1;
  }
  controller_close_anchor_control(controller);
  if (controller->anchor_event_fd >= 0) {
    close(controller->anchor_event_fd);
    controller->anchor_event_fd = -1;
  }
#if defined(__linux__)
  cgroup_context_close(&controller->cgroup);
#endif
}

static void emergency_cleanup(struct controller *controller) {
  if (controller->state == GO_LIKE_E2E_STATE_ANCHOR_READY ||
      controller->state == GO_LIKE_E2E_STATE_RUNNING ||
      controller->state == GO_LIKE_E2E_STATE_TARGET_EXITED || controller->prepare_pending ||
      controller->start_pending) {
    (void)finalize_controller(controller, 0u, false, true);
  }
}

static int terminal_protocol_error(struct controller *controller, uint64_t request_id,
                                   enum go_like_e2e_error_code code, int system_errno,
                                   const char *message) {
  emergency_cleanup(controller);
  (void)send_error(controller, request_id, code, system_errno, true, message);
  controller->state = GO_LIKE_E2E_STATE_FAILED;
  controller->exit_code = 70;
  return -1;
}

static int process_one_wire_frame(struct controller *controller, const uint8_t *body,
                                  size_t body_length) {
  struct request_frame frame;
  memset(&frame, 0, sizeof(frame));
  if (parse_request_body(body, body_length, &frame) < 0) {
    enum go_like_e2e_error_code code =
        errno == EPROTONOSUPPORT ? GO_LIKE_E2E_ERROR_VERSION : GO_LIKE_E2E_ERROR_PROTOCOL;
    return terminal_protocol_error(controller, 0u, code, errno,
                                   "invalid frame header or protocol version");
  }
  int result = dispatch_request(controller, &frame);
  if (result >= 0) {
    return 0;
  }
  if (result == -2) {
    return terminal_protocol_error(controller, frame.request_id, GO_LIKE_E2E_ERROR_NONCE,
                                   errno, "request nonce did not authenticate");
  }
  if (result == -3) {
    return terminal_protocol_error(controller, frame.request_id,
                                   GO_LIKE_E2E_ERROR_REQUEST_ID, errno,
                                   "request ID was duplicate, stale, or out of order");
  }
  if (result == -4) {
    return terminal_protocol_error(controller, frame.request_id,
                                   GO_LIKE_E2E_ERROR_UNKNOWN_FRAME, errno,
                                   "unknown request frame type");
  }
  enum go_like_e2e_error_code code = GO_LIKE_E2E_ERROR_INVALID_STATE;
  const char *message = "request was invalid for the current controller state";
#if defined(__linux__)
  char strict_message[192];
#endif
  if (frame.type == GO_LIKE_E2E_REQUEST_PREPARE) {
#if defined(__linux__)
    if (controller->mode == GO_LIKE_E2E_MODE_LINUX_CGROUP_V2_STRICT ||
        (frame.payload_length >= 4u &&
         load_u32_be(frame.payload) == GO_LIKE_E2E_MODE_LINUX_CGROUP_V2_STRICT)) {
      int failure_errno = errno;
      code = GO_LIKE_E2E_ERROR_CGROUP_PREREQUISITE;
      int message_length =
          snprintf(strict_message, sizeof(strict_message),
                   "strict delegated cgroup v2 setup failed before target start: "
                   "stage=%s; no PID/PGID fallback was attempted",
                   cgroup_stage_name(controller->cgroup_stage));
      if (message_length < 0 || (size_t)message_length >= sizeof(strict_message)) {
        message = "strict delegated cgroup v2 setup failed before target start; "
                  "no PID/PGID fallback was attempted";
      } else {
        message = strict_message;
      }
      errno = failure_errno;
    } else
#endif
    {
      code = GO_LIKE_E2E_ERROR_INVALID_PAYLOAD;
      message = "PREPARE payload or anchor setup was invalid";
    }
  } else if (frame.type == GO_LIKE_E2E_REQUEST_START) {
    code = GO_LIKE_E2E_ERROR_ANCHOR;
    message = "START failed before target execution";
  }
  return terminal_protocol_error(controller, frame.request_id, code, errno, message);
}

static int consume_control_input(struct controller *controller, bool *saw_eof) {
  *saw_eof = false;
  while (true) {
    if (controller->input_length == sizeof(controller->input)) {
      return terminal_protocol_error(controller, 0u, GO_LIKE_E2E_ERROR_PROTOCOL,
                                     EOVERFLOW, "control input exceeded the bounded frame buffer");
    }
    ssize_t count = read(GO_LIKE_E2E_CONTROL_FD,
                         controller->input + controller->input_length,
                         sizeof(controller->input) - controller->input_length);
    if (count > 0) {
      controller->input_length += (size_t)count;
    } else if (count == 0) {
      *saw_eof = true;
      break;
    } else if (errno == EINTR) {
      continue;
    } else if (errno == EAGAIN || errno == EWOULDBLOCK) {
      break;
    } else {
      return terminal_protocol_error(controller, 0u, GO_LIKE_E2E_ERROR_PROTOCOL, errno,
                                     "control channel read failed");
    }
  }

  while (controller->input_length >= GO_LIKE_E2E_FRAME_PREFIX_SIZE) {
    uint32_t body_length = load_u32_be(controller->input);
    if (body_length < GO_LIKE_E2E_FRAME_HEADER_SIZE ||
        body_length > GO_LIKE_E2E_MAX_FRAME_BODY) {
      return terminal_protocol_error(controller, 0u, GO_LIKE_E2E_ERROR_PROTOCOL,
                                     EMSGSIZE, "frame length was outside protocol bounds");
    }
    size_t wire_length = GO_LIKE_E2E_FRAME_PREFIX_SIZE + (size_t)body_length;
    if (controller->input_length < wire_length) {
      break;
    }
    if (process_one_wire_frame(controller,
                               controller->input + GO_LIKE_E2E_FRAME_PREFIX_SIZE,
                               body_length) < 0) {
      return -1;
    }
    memmove(controller->input, controller->input + wire_length,
            controller->input_length - wire_length);
    controller->input_length -= wire_length;
    if (controller->state == GO_LIKE_E2E_STATE_CLOSED) {
      return 0;
    }
  }
  if (*saw_eof) {
    if (controller->input_length != 0u) {
      return terminal_protocol_error(controller, 0u, GO_LIKE_E2E_ERROR_TRUNCATED_FRAME,
                                     EPROTO, "control channel ended inside a frame");
    }
    return terminal_protocol_error(controller, 0u, GO_LIKE_E2E_ERROR_PROTOCOL, EPIPE,
                                   "control channel ended before authenticated CLOSE");
  }
  return 0;
}

static int send_controller_ready(struct controller *controller) {
  struct byte_buffer payload = {0};
  int result = -1;
  if (byte_buffer_append_u32(&payload, controller->platform) < 0 ||
      byte_buffer_append_u32(&payload, controller->capabilities) < 0 ||
      byte_buffer_append_u32(&payload, (uint32_t)getpid()) < 0 ||
      byte_buffer_append_u32(&payload, GO_LIKE_E2E_MAX_FRAME_BODY) < 0 ||
      byte_buffer_append_u32(&payload, GO_LIKE_E2E_HARD_BUDGET_MS) < 0 ||
      byte_buffer_append_u32(&payload, GO_LIKE_E2E_MACOS_MAX_KILL_ROUNDS) < 0) {
    goto done;
  }
  result = send_frame(controller, GO_LIKE_E2E_RESPONSE_CONTROLLER_READY,
                      GO_LIKE_E2E_RESPONSE_FLAG_EVENT, 0u, payload.data, payload.length);
done:
  byte_buffer_free(&payload);
  return result;
}

static int controller_loop(struct controller *controller) {
  while (controller->state != GO_LIKE_E2E_STATE_CLOSED &&
         controller->state != GO_LIKE_E2E_STATE_FAILED) {
    if (shutdown_signal != 0) {
      int signal_number = shutdown_signal;
      emergency_cleanup(controller);
      (void)send_error(controller, 0u, GO_LIKE_E2E_ERROR_INTERNAL, EINTR, true,
                       "controller received a termination signal");
      controller->exit_code = 128 + signal_number;
      controller->state = GO_LIKE_E2E_STATE_FAILED;
      break;
    }
    struct pollfd poll_fds[2];
    nfds_t count = 0u;
    poll_fds[count].fd = GO_LIKE_E2E_CONTROL_FD;
    poll_fds[count].events = POLLIN | POLLHUP | POLLERR;
    poll_fds[count].revents = 0;
    count += 1u;
    if (controller->anchor_event_fd >= 0 && !controller->anchor_event_eof) {
      poll_fds[count].fd = controller->anchor_event_fd;
      poll_fds[count].events = POLLIN | POLLHUP | POLLERR;
      poll_fds[count].revents = 0;
      count += 1u;
    }
    int poll_timeout =
        controller->mode == GO_LIKE_E2E_MODE_ANCHORED_MANAGED &&
                (controller->state == GO_LIKE_E2E_STATE_RUNNING ||
                 controller->state == GO_LIKE_E2E_STATE_TARGET_EXITED)
            ? GO_LIKE_E2E_INTERNAL_POLL_MS
            : -1;
    int result = poll(poll_fds, count, poll_timeout);
    if (result < 0) {
      if (errno == EINTR) {
        continue;
      }
      return terminal_protocol_error(controller, 0u, GO_LIKE_E2E_ERROR_INTERNAL,
                                     errno, "controller poll failed");
    }
    if (result == 0 && poll_timeout >= 0) {
      (void)refresh_tracker(controller);
      continue;
    }
    if (count > 1u && poll_fds[1].revents != 0) {
      if (drain_anchor_events(controller) < 0) {
        return terminal_protocol_error(controller, 0u, GO_LIKE_E2E_ERROR_ANCHOR,
                                       errno, "anchor status channel failed");
      }
      if (controller->anchor_event_eof &&
          controller->state != GO_LIKE_E2E_STATE_FINALIZED &&
          controller->state != GO_LIKE_E2E_STATE_CLOSED) {
        return terminal_protocol_error(controller, 0u, GO_LIKE_E2E_ERROR_ANCHOR,
                                       EPIPE, "anchor exited before final observation");
      }
    }
    if (poll_fds[0].revents != 0) {
      bool saw_eof = false;
      if (consume_control_input(controller, &saw_eof) < 0) {
        return -1;
      }
    }
  }
  return controller->exit_code;
}

static int validate_controller_fds(void) {
  const int fds[] = {GO_LIKE_E2E_CONTROL_FD, GO_LIKE_E2E_RESPONSE_FD,
                     GO_LIKE_E2E_TARGET_STDOUT_FD, GO_LIKE_E2E_TARGET_STDERR_FD};
  for (size_t index = 0u; index < ARRAY_LENGTH(fds); index += 1u) {
    if (fcntl(fds[index], F_GETFD) < 0 || set_cloexec(fds[index]) < 0) {
      return -1;
    }
  }
  return set_nonblocking(GO_LIKE_E2E_CONTROL_FD);
}

static int install_controller_signal_handlers(void) {
  struct sigaction ignored;
  memset(&ignored, 0, sizeof(ignored));
  ignored.sa_handler = SIG_IGN;
  sigemptyset(&ignored.sa_mask);
  if (sigaction(SIGPIPE, &ignored, NULL) < 0) {
    return -1;
  }
  struct sigaction handled;
  memset(&handled, 0, sizeof(handled));
  handled.sa_handler = record_shutdown_signal;
  sigemptyset(&handled.sa_mask);
  const int signals[] = {SIGTERM, SIGINT, SIGHUP};
  for (size_t index = 0u; index < ARRAY_LENGTH(signals); index += 1u) {
    if (sigaction(signals[index], &handled, NULL) < 0) {
      return -1;
    }
  }
  return 0;
}

static void controller_initialize(struct controller *controller) {
  memset(controller, 0, sizeof(*controller));
  controller->state = GO_LIKE_E2E_STATE_READY;
  controller->mode = GO_LIKE_E2E_MODE_ANCHORED_MANAGED;
  controller->anchor_pid = -1;
  controller->target_pid = -1;
  controller->anchor_control_fd = -1;
  controller->anchor_event_fd = -1;
  controller->target_pidfd = -1;
#if defined(__APPLE__)
  controller->platform = GO_LIKE_E2E_PLATFORM_MACOS;
  controller->capabilities =
      GO_LIKE_E2E_CAPABILITY_ANCHORED_GROUP | GO_LIKE_E2E_CAPABILITY_MACOS_LIBPROC;
#elif defined(__linux__)
  controller->platform = GO_LIKE_E2E_PLATFORM_LINUX;
  controller->capabilities = GO_LIKE_E2E_CAPABILITY_ANCHORED_GROUP |
                             GO_LIKE_E2E_CAPABILITY_LINUX_CGROUP_V2 |
                             GO_LIKE_E2E_CAPABILITY_LINUX_PIDFD;
  cgroup_context_initialize(&controller->cgroup);
#endif
}

static void controller_destroy(struct controller *controller) {
  controller_close_fds(controller);
  target_spec_free(&controller->target);
  free(controller->tracked);
  controller->tracked = NULL;
  controller->tracked_count = 0u;
  controller->tracked_capacity = 0u;
}

static int append_test_string(struct byte_buffer *payload, const char *value) {
  size_t length = strlen(value);
  return byte_buffer_append_u32(payload, (uint32_t)length) < 0 ||
                 byte_buffer_append(payload, value, length) < 0
             ? -1
             : 0;
}

static int run_self_test(void) {
  struct byte_buffer prepare = {0};
  struct target_spec parsed;
  memset(&parsed, 0, sizeof(parsed));
  enum go_like_e2e_process_mode mode = 0;
  int result = 1;
  if (byte_buffer_append_u32(&prepare, GO_LIKE_E2E_MODE_ANCHORED_MANAGED) < 0 ||
      byte_buffer_append_u32(&prepare, 2u) < 0 ||
      byte_buffer_append_u32(&prepare, 1u) < 0 || append_test_string(&prepare, "/") < 0 ||
      append_test_string(&prepare, "/usr/bin/printf") < 0 ||
      append_test_string(&prepare, "self-test") < 0 ||
      byte_buffer_append_u32(&prepare, 4u) < 0 ||
      byte_buffer_append_u32(&prepare, 13u) < 0 ||
      byte_buffer_append(&prepare, "PATH", 4u) < 0 ||
      byte_buffer_append(&prepare, "/usr/bin:/bin", 13u) < 0) {
    goto done;
  }
  if (parse_prepare_payload(prepare.data, prepare.length, &mode, &parsed) < 0 ||
      mode != GO_LIKE_E2E_MODE_ANCHORED_MANAGED || parsed.argc != 2u ||
      parsed.envc != 1u || strcmp(parsed.cwd, "/") != 0 ||
      strcmp(parsed.argv[0], "/usr/bin/printf") != 0 ||
      strcmp(parsed.envp[0], "PATH=/usr/bin:/bin") != 0) {
    goto done;
  }
  uint8_t body[GO_LIKE_E2E_FRAME_HEADER_SIZE];
  memset(body, 0, sizeof(body));
  store_u32_be(body + GO_LIKE_E2E_HEADER_MAGIC_OFFSET, GO_LIKE_E2E_FRAME_MAGIC);
  store_u16_be(body + GO_LIKE_E2E_HEADER_VERSION_OFFSET, GO_LIKE_E2E_PROTOCOL_VERSION);
  store_u16_be(body + GO_LIKE_E2E_HEADER_TYPE_OFFSET, GO_LIKE_E2E_REQUEST_QUERY);
  store_u64_be(body + GO_LIKE_E2E_HEADER_REQUEST_ID_OFFSET, UINT64_C(42));
  struct request_frame frame;
  memset(&frame, 0, sizeof(frame));
  if (parse_request_body(body, sizeof(body), &frame) < 0 ||
      frame.type != GO_LIKE_E2E_REQUEST_QUERY || frame.request_id != UINT64_C(42) ||
      frame.payload_length != 0u || load_u32_be(body) != GO_LIKE_E2E_FRAME_MAGIC) {
    goto done;
  }
  result = 0;
done:
  target_spec_free(&parsed);
  byte_buffer_free(&prepare);
  if (result == 0) {
    puts("go-like_e2e_posix_controller self-test: PASS");
  } else {
    fputs("go-like_e2e_posix_controller self-test: FAIL\n", stderr);
  }
  return result;
}

#if defined(__linux__)
static const char *cgroup_stage_name(enum cgroup_stage stage) {
  switch (stage) {
    case CGROUP_STAGE_OPEN_PARENT:
      return "open-parent";
    case CGROUP_STAGE_NAME_PATHS:
      return "name-paths";
    case CGROUP_STAGE_CREATE_INVOCATION:
      return "create-invocation";
    case CGROUP_STAGE_OPEN_INVOCATION:
      return "open-invocation";
    case CGROUP_STAGE_VALIDATE_INVOCATION:
      return "validate-invocation";
    case CGROUP_STAGE_DISCOVER_MOUNT:
      return "discover-cgroup2-mount";
    case CGROUP_STAGE_PROBE:
      return "probe-enroll-kill-events-rmdir";
    case CGROUP_STAGE_CREATE_COMMAND:
      return "create-command-leaf";
    case CGROUP_STAGE_OPEN_COMMAND:
      return "open-command-leaf";
    case CGROUP_STAGE_VALIDATE_COMMAND:
      return "validate-command-leaf";
    case CGROUP_STAGE_OPEN_CONTROL_FILES:
      return "open-procs-kill-events";
    case CGROUP_STAGE_VALIDATE_EMPTY_COMMAND:
      return "validate-empty-command-leaf";
    case CGROUP_STAGE_READY:
      return "ready";
    case CGROUP_STAGE_REMOVE_TREE:
      return "remove-command-and-invocation";
    case CGROUP_STAGE_NOT_STARTED:
    default:
      return "not-started";
  }
}
#endif

static int run_cgroup_preflight(struct controller *controller) {
#if defined(__linux__)
  if (controller->configured_cgroup_parent[0] == '\0') {
    fprintf(stderr, "cgroup preflight failed: delegated parent was not configured\n");
    return 78;
  }
  if (random_nonce(controller->nonce) < 0 || cgroup_setup(controller) < 0) {
    int setup_errno = errno;
    (void)cgroup_remove_tree(&controller->cgroup);
    fprintf(stderr, "cgroup preflight failed: stage=%s error=%s\n",
            cgroup_stage_name(controller->cgroup_stage), strerror(setup_errno));
    errno = setup_errno;
    return 78;
  }
  controller->cgroup_stage = CGROUP_STAGE_REMOVE_TREE;
  if (cgroup_remove_tree(&controller->cgroup) < 0) {
    fprintf(stderr, "cgroup preflight cleanup failed: stage=%s error=%s\n",
            cgroup_stage_name(controller->cgroup_stage), strerror(errno));
    return 78;
  }
  puts("go-like_e2e_posix_controller cgroup preflight: PASS");
  return 0;
#else
  (void)controller;
  fputs("cgroup preflight failed: platform is not Linux\n", stderr);
  return 78;
#endif
}

static int parse_startup_arguments(struct controller *controller, int argc, char **argv,
                                   bool *self_test, bool *cgroup_preflight) {
  *self_test = false;
  *cgroup_preflight = false;
  const char *argument_parent = NULL;
  for (int index = 1; index < argc; index += 1) {
    if (strcmp(argv[index], "--self-test") == 0) {
      *self_test = true;
    } else if (strcmp(argv[index], "--cgroup-preflight") == 0) {
      *cgroup_preflight = true;
    } else if (strcmp(argv[index], "--cgroup-parent") == 0) {
      if (argument_parent != NULL || index + 1 >= argc) {
        errno = EINVAL;
        return -1;
      }
      argument_parent = argv[index + 1];
      index += 1;
    } else {
      errno = EINVAL;
      return -1;
    }
  }
  if (*self_test && *cgroup_preflight) {
    errno = EINVAL;
    return -1;
  }
#if defined(__linux__)
  const char *environment_parent = getenv("GO_LIKE_E2E_CGROUP_PARENT");
  if (argument_parent != NULL && environment_parent != NULL && environment_parent[0] != '\0' &&
      strcmp(argument_parent, environment_parent) != 0) {
    errno = EINVAL;
    return -1;
  }
  const char *selected_parent = argument_parent != NULL ? argument_parent : environment_parent;
  if (selected_parent != NULL && selected_parent[0] != '\0') {
    size_t length = strlen(selected_parent);
    if (length >= sizeof(controller->configured_cgroup_parent)) {
      errno = ENAMETOOLONG;
      return -1;
    }
    memcpy(controller->configured_cgroup_parent, selected_parent, length + 1u);
  }
#else
  (void)controller;
  if (argument_parent != NULL) {
    errno = ENOTSUP;
    return -1;
  }
#endif
  return 0;
}

int main(int argc, char **argv) {
  struct controller controller;
  controller_initialize(&controller);
  bool self_test = false;
  bool cgroup_preflight = false;
  if (parse_startup_arguments(&controller, argc, argv, &self_test, &cgroup_preflight) < 0) {
    fprintf(stderr, "go-like_e2e_posix_controller: invalid startup arguments: %s\n",
            strerror(errno));
    controller_destroy(&controller);
    return 64;
  }
  if (self_test) {
    controller_destroy(&controller);
    return run_self_test();
  }
  if (cgroup_preflight) {
    int preflight_result = run_cgroup_preflight(&controller);
    controller_destroy(&controller);
    return preflight_result;
  }
#if defined(__linux__)
  if (prctl(PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0) < 0) {
    fprintf(stderr, "go-like_e2e_posix_controller: PR_SET_CHILD_SUBREAPER failed: %s\n",
            strerror(errno));
    controller_destroy(&controller);
    return 69;
  }
#endif
  if (validate_controller_fds() < 0 || install_controller_signal_handlers() < 0 ||
      random_nonce(controller.nonce) < 0) {
    fprintf(stderr, "go-like_e2e_posix_controller: startup failed: %s\n", strerror(errno));
    controller_destroy(&controller);
    return 69;
  }
  if (send_controller_ready(&controller) < 0) {
    controller_destroy(&controller);
    return 74;
  }
  int result = controller_loop(&controller);
  if (result < 0) {
    result = controller.exit_code == 0 ? 70 : controller.exit_code;
  }
  emergency_cleanup(&controller);
  controller_destroy(&controller);
  return result;
}
