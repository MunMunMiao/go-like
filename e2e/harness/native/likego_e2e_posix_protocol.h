#ifndef LIKEGO_E2E_POSIX_PROTOCOL_H
#define LIKEGO_E2E_POSIX_PROTOCOL_H

#include <stdint.h>

/*
 * LikeGo E2E native POSIX controller protocol, version 1.
 *
 * Transport expected by the controller when launched through Bun extra stdio:
 *   fd 0: request frames written by the TypeScript supervisor
 *   fd 3: response/event frames written by this controller
 *   fd 4: target stdout (the controller/anchor close their copies after fork)
 *   fd 5: target stderr (the controller/anchor close their copies after fork)
 *
 * All integer fields are unsigned big-endian unless explicitly described as
 * signed. Strings are length-delimited byte strings and MUST NOT contain NUL.
 * Target argv and target environment exist only in PREPARE payload data; they
 * are never accepted as controller command-line arguments.
 *
 * A wire frame is:
 *
 *   u32 body_length                 bytes after this prefix, <= MAX_FRAME_BODY
 *   u32 magic                       LIKEGO_E2E_FRAME_MAGIC
 *   u16 version                     LIKEGO_E2E_PROTOCOL_VERSION
 *   u16 type                        enum likego_e2e_frame_type
 *   u32 flags                       zero for every request
 *   u64 request_id                  nonzero, strictly increasing for requests
 *   u8  nonce[32]                   nonce from CONTROLLER_READY
 *   u8  payload[body_length - 52]
 *
 * The fixed body header is deliberately described by offsets rather than a C
 * struct so TypeScript encoders do not depend on ABI padding or host endian.
 * The controller generates the nonce with the OS CSPRNG and sends it in the
 * CONTROLLER_READY header. Every subsequent request must echo it. Duplicate,
 * stale, unknown, malformed, oversized, and truncated frames are terminal
 * protocol failures and cause fail-closed target cleanup.
 */

#define LIKEGO_E2E_FRAME_MAGIC UINT32_C(0x4c475033) /* ASCII "LGP3" */
#define LIKEGO_E2E_PROTOCOL_VERSION UINT16_C(1)
#define LIKEGO_E2E_NONCE_SIZE 32u
#define LIKEGO_E2E_FRAME_PREFIX_SIZE 4u
#define LIKEGO_E2E_FRAME_HEADER_SIZE 52u
#define LIKEGO_E2E_MAX_FRAME_BODY (1024u * 1024u)
#define LIKEGO_E2E_MAX_WIRE_FRAME \
  (LIKEGO_E2E_FRAME_PREFIX_SIZE + LIKEGO_E2E_MAX_FRAME_BODY)

#define LIKEGO_E2E_HEADER_MAGIC_OFFSET 0u
#define LIKEGO_E2E_HEADER_VERSION_OFFSET 4u
#define LIKEGO_E2E_HEADER_TYPE_OFFSET 6u
#define LIKEGO_E2E_HEADER_FLAGS_OFFSET 8u
#define LIKEGO_E2E_HEADER_REQUEST_ID_OFFSET 12u
#define LIKEGO_E2E_HEADER_NONCE_OFFSET 20u
#define LIKEGO_E2E_HEADER_PAYLOAD_OFFSET LIKEGO_E2E_FRAME_HEADER_SIZE

#define LIKEGO_E2E_RESPONSE_FLAG_EVENT UINT32_C(0x00000001)
#define LIKEGO_E2E_RESPONSE_FLAG_TERMINAL UINT32_C(0x00000002)

#define LIKEGO_E2E_MAX_ARGC 256u
#define LIKEGO_E2E_MAX_ENVC 1024u
#define LIKEGO_E2E_MAX_STRING_BYTES (64u * 1024u)
#define LIKEGO_E2E_MAX_CWD_BYTES 4096u
#define LIKEGO_E2E_MAX_CGROUP_IDENTITY_BYTES 4096u

#define LIKEGO_E2E_MACOS_MAX_KILL_ROUNDS 3u
#define LIKEGO_E2E_HARD_BUDGET_MS 1900u
#define LIKEGO_E2E_TERM_GRACE_MS 300u
#define LIKEGO_E2E_KILL_ROUND_WAIT_MS 400u

/* Requests. */
enum likego_e2e_frame_type {
  LIKEGO_E2E_REQUEST_PREPARE = 0x0001,
  LIKEGO_E2E_REQUEST_START = 0x0002,
  LIKEGO_E2E_REQUEST_FINALIZE = 0x0003,
  LIKEGO_E2E_REQUEST_TERMINATE = 0x0004,
  LIKEGO_E2E_REQUEST_QUERY = 0x0005,
  LIKEGO_E2E_REQUEST_DIRECT_SIGNAL = 0x0006,
  LIKEGO_E2E_REQUEST_CLOSE = 0x0007,
  /* Abort/timeout hard phase: strict cgroup.kill or anchored KILL-only rounds. */
  LIKEGO_E2E_REQUEST_HARD_TERMINATE = 0x0008,

  /* Responses and asynchronous events. */
  LIKEGO_E2E_RESPONSE_CONTROLLER_READY = 0x8001,
  LIKEGO_E2E_RESPONSE_ANCHOR_READY = 0x8002,
  LIKEGO_E2E_RESPONSE_TARGET_STARTED = 0x8003,
  LIKEGO_E2E_RESPONSE_TARGET_EXIT = 0x8004,
  LIKEGO_E2E_RESPONSE_FINALIZED = 0x8005,
  LIKEGO_E2E_RESPONSE_QUERY = 0x8006,
  LIKEGO_E2E_RESPONSE_DIRECT_SIGNAL_SENT = 0x8007,
  LIKEGO_E2E_RESPONSE_CLOSED = 0x8008,
  LIKEGO_E2E_RESPONSE_ERROR = 0x80ff
};

enum likego_e2e_platform {
  LIKEGO_E2E_PLATFORM_MACOS = 1,
  LIKEGO_E2E_PLATFORM_LINUX = 2
};

enum likego_e2e_capability {
  LIKEGO_E2E_CAPABILITY_ANCHORED_GROUP = 1u << 0,
  LIKEGO_E2E_CAPABILITY_MACOS_LIBPROC = 1u << 1,
  LIKEGO_E2E_CAPABILITY_LINUX_CGROUP_V2 = 1u << 2,
  LIKEGO_E2E_CAPABILITY_LINUX_PIDFD = 1u << 3
};

enum likego_e2e_process_mode {
  /* macOS and Linux live-anchor, bounded best-effort cleanup. */
  LIKEGO_E2E_MODE_ANCHORED_MANAGED = 1,
  /* Linux only: delegated cgroup v2; no PID/PGID cleanup fallback. */
  LIKEGO_E2E_MODE_LINUX_CGROUP_V2_STRICT = 2
};

enum likego_e2e_controller_state {
  LIKEGO_E2E_STATE_READY = 1,
  LIKEGO_E2E_STATE_ANCHOR_READY = 2,
  LIKEGO_E2E_STATE_RUNNING = 3,
  LIKEGO_E2E_STATE_TARGET_EXITED = 4,
  LIKEGO_E2E_STATE_FINALIZED = 5,
  LIKEGO_E2E_STATE_CLOSED = 6,
  LIKEGO_E2E_STATE_FAILED = 7
};

enum likego_e2e_exit_kind {
  LIKEGO_E2E_EXIT_UNKNOWN = 0,
  LIKEGO_E2E_EXIT_CODE = 1,
  LIKEGO_E2E_EXIT_SIGNAL = 2,
  LIKEGO_E2E_EXIT_EXEC_FAILURE = 3
};

enum likego_e2e_cleanup_result {
  LIKEGO_E2E_CLEANUP_ZERO_OBSERVED = 0,
  LIKEGO_E2E_CLEANUP_RESIDUAL_PRESENT = 1,
  LIKEGO_E2E_CLEANUP_INCONCLUSIVE = 2,
  LIKEGO_E2E_CLEANUP_PLATFORM_FAILURE = 3
};

enum likego_e2e_error_code {
  LIKEGO_E2E_ERROR_PROTOCOL = 1,
  LIKEGO_E2E_ERROR_VERSION = 2,
  LIKEGO_E2E_ERROR_NONCE = 3,
  LIKEGO_E2E_ERROR_REQUEST_ID = 4,
  LIKEGO_E2E_ERROR_UNKNOWN_FRAME = 5,
  LIKEGO_E2E_ERROR_TRUNCATED_FRAME = 6,
  LIKEGO_E2E_ERROR_INVALID_STATE = 7,
  LIKEGO_E2E_ERROR_INVALID_PAYLOAD = 8,
  LIKEGO_E2E_ERROR_PLATFORM_UNSUPPORTED = 9,
  LIKEGO_E2E_ERROR_CGROUP_PREREQUISITE = 10,
  LIKEGO_E2E_ERROR_CGROUP_OPERATION = 11,
  LIKEGO_E2E_ERROR_ANCHOR = 12,
  LIKEGO_E2E_ERROR_TARGET_EXEC = 13,
  LIKEGO_E2E_ERROR_PIDFD_UNAVAILABLE = 14,
  LIKEGO_E2E_ERROR_DIRECT_SIGNAL = 15,
  LIKEGO_E2E_ERROR_OBSERVATION = 16,
  LIKEGO_E2E_ERROR_INTERNAL = 17
};

/*
 * PREPARE request payload:
 *
 *   u32 process_mode
 *   u32 argc
 *   u32 envc
 *   u32 cwd_length
 *   u8  cwd[cwd_length]            required absolute path, no NUL
 *   repeated argc times:
 *     u32 argument_length
 *     u8  argument[argument_length] argument 0 must be nonempty
 *   repeated envc times:
 *     u32 key_length
 *     u32 value_length
 *     u8  key[key_length]           nonempty, no NUL or '='
 *     u8  value[value_length]       no NUL
 *
 * The strict Linux cgroup parent is NOT target environment. It is supplied to
 * the controller itself through --cgroup-parent PATH or the controller's
 * LIKEGO_E2E_CGROUP_PARENT environment variable. The controller canonicalizes
 * and opens it before any target fork.
 */

/*
 * START, FINALIZE, TERMINATE, HARD_TERMINATE, QUERY, and CLOSE have empty
 * payloads. FINALIZE is the natural-exit descendant cleanup request. In
 * anchored mode, TERMINATE is the combined TERM-then-KILL request and
 * HARD_TERMINATE is the explicit abort/timeout request that skips TERM and
 * begins the existing bounded KILL rounds with fresh observation. Strict mode
 * uses cgroup.kill for all three cleanup requests. Request flags remain zero
 * and never select this policy.
 */

/*
 * DIRECT_SIGNAL request payload:
 *   u32 signal_number
 *
 * It is Linux-only and targets the direct target identity through pidfd. If a
 * pidfd was not obtained immediately after target fork, the request fails
 * closed. It is never implemented with kill(numeric_pid, ...), and it is not a
 * containment operation.
 */

/*
 * CONTROLLER_READY response payload:
 *   u32 platform
 *   u32 capability_bits
 *   u32 controller_pid
 *   u32 max_frame_body
 *   u32 hard_budget_ms
 *   u32 max_kill_rounds
 */

/*
 * ANCHOR_READY response payload:
 *   u32 process_mode
 *   u32 anchor_pid
 *   u32 process_group_id
 *   u32 session_id
 *   u32 cgroup_identity_length
 *   u8  cgroup_identity[cgroup_identity_length]  empty outside strict Linux
 */

/*
 * TARGET_STARTED response payload:
 *   u32 target_pid                 diagnostic only; never numeric signal auth
 *   u32 pidfd_available            0 or 1
 */

/*
 * TARGET_EXIT event payload:
 *   u32 exit_kind
 *   i32 exit_value                 exit code, signal number, or exec errno
 *   u32 core_dumped                0 or 1
 */

/*
 * FINALIZED response payload:
 *   u32 cleanup_result
 *   u32 term_sent                  0 or 1
 *   u32 kill_rounds                0..3 in anchored mode, 0 in strict mode
 *   u32 same_group_live_members    excludes anchor
 *   u32 breakaway_live_members     diagnostic only; never numerically signaled
 *   u32 cgroup_populated           0, 1, or UINT32_MAX when not applicable
 *   u32 target_status_known        0 or 1
 *   u32 target_exit_kind
 *   i32 target_exit_value
 *   u32 detail_length
 *   u8  detail[detail_length]      bounded fixed diagnostic, no argv/env
 */

/*
 * QUERY response payload:
 *   u32 controller_state
 *   u32 process_mode
 *   u32 anchor_pid
 *   u32 target_pid
 *   u32 target_status_known
 *   u32 target_exit_kind
 *   i32 target_exit_value
 *   u32 same_group_live_members
 *   u32 breakaway_live_members
 *   u32 cgroup_populated           0, 1, or UINT32_MAX when not applicable
 */

/* DIRECT_SIGNAL_SENT payload: u32 signal_number. */
/* CLOSED payload: empty. */

/*
 * ERROR response payload:
 *   u32 error_code
 *   i32 system_errno               zero when not applicable
 *   u32 terminal                   0 or 1
 *   u32 message_length
 *   u8  message[message_length]    bounded fixed diagnostic, no argv/env
 */

#endif /* LIKEGO_E2E_POSIX_PROTOCOL_H */
