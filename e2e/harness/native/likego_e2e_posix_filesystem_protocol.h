#ifndef LIKEGO_E2E_POSIX_FILESYSTEM_PROTOCOL_H
#define LIKEGO_E2E_POSIX_FILESYSTEM_PROTOCOL_H

/*
 * LikeGo POSIX filesystem broker protocol, version 1.
 *
 * All integers use little-endian byte order. Requests and responses both use
 * a fixed 32-byte header followed by payload_length bytes.
 *
 * Request header:
 *   0  u32 magic
 *   4  u16 version
 *   6  u16 opcode
 *   8  u64 nonzero request_id
 *  16  u32 directory_handle_id
 *  20  u32 flags
 *  24  u32 payload_length
 *  28  u32 reserved (must be zero)
 *
 * Response header:
 *   0  u32 magic
 *   4  u16 version
 *   6  u16 opcode | LGFS_RESPONSE_BIT
 *   8  u64 request_id
 *  16  u32 status
 *  20  u32 errno captured at the failing native operation
 *  24  u32 directory_handle_id on success, portable error code on failure
 *  28  u32 payload_length
 *
 * Payloads contain only bounded bytes and single validated path components.
 * The sole absolute-path operation is LGFS_OPEN_ROOT. All child operations
 * are relative to directory descriptors retained by the broker.
 *
 * LGFS_REMOVE_TREE has an irreversible commit point. LGFS_STATUS_INCOMPLETE
 * for that opcode means the request failed to complete every durability or
 * close guarantee, but the request handle was consumed and must not be used
 * or closed again. LGFS_CLOSE_HANDLE likewise consumes its handle before a
 * possible LGFS_STATUS_INCOMPLETE close diagnostic. Other opcodes define
 * LGFS_STATUS_INCOMPLETE independently.
 */

#define LGFS_MAGIC 0x5346474cU
#define LGFS_VERSION 1U
#define LGFS_HEADER_SIZE 32U
#define LGFS_MAX_PAYLOAD (4U * 1024U * 1024U + 4096U)
#define LGFS_MAX_HANDLES 4096U
#define LGFS_MAX_COMPONENT 128U
#define LGFS_MAX_STABILIZATION_MS 30000U

#define LGFS_RESPONSE_BIT 0x8000U

#define LGFS_OPEN_ROOT 1U
#define LGFS_ENSURE_PRIVATE_CHILD 2U
#define LGFS_CREATE_PRIVATE_CHILD 3U
#define LGFS_OPEN_PRIVATE_CHILD 4U
#define LGFS_VERIFY_DIRECTORY 5U
#define LGFS_WRITE_FILE 6U
#define LGFS_READ_FILE 7U
#define LGFS_REMOVE_TREE 8U
#define LGFS_CLOSE_HANDLE 9U
#define LGFS_SHUTDOWN 10U
#define LGFS_READ_PROCESS_IDENTITY 11U

#define LGFS_STATUS_OK 0U
#define LGFS_STATUS_SYSTEM 1U
#define LGFS_STATUS_INVALID 2U
#define LGFS_STATUS_IDENTITY 3U
#define LGFS_STATUS_LIMIT 4U
#define LGFS_STATUS_INCOMPLETE 5U
#define LGFS_STATUS_WRONG_TYPE 6U
#define LGFS_STATUS_PERMISSIONS 7U

#define LGFS_ERROR_UNKNOWN 0U
#define LGFS_ERROR_NO_ENTRY 1U
#define LGFS_ERROR_EXISTS 2U
#define LGFS_ERROR_SYMBOLIC_LINK 3U
#define LGFS_ERROR_NOT_DIRECTORY 4U
#define LGFS_ERROR_IS_DIRECTORY 5U
#define LGFS_ERROR_ACCESS 6U
#define LGFS_ERROR_PERMISSION 7U
#define LGFS_ERROR_NO_SPACE 8U
#define LGFS_ERROR_PROCESS_FILE_LIMIT 9U
#define LGFS_ERROR_SYSTEM_FILE_LIMIT 10U
#define LGFS_ERROR_IO 11U
#define LGFS_ERROR_OVERFLOW 12U
#define LGFS_ERROR_BAD_DESCRIPTOR 13U
#define LGFS_ERROR_NOT_EMPTY 14U
#define LGFS_ERROR_CROSS_DEVICE 15U
#define LGFS_ERROR_INTERRUPTED 16U
#define LGFS_ERROR_TIMED_OUT 17U
#define LGFS_ERROR_STALE 18U
#define LGFS_ERROR_BUSY 19U
#define LGFS_ERROR_TOO_LARGE 20U
#define LGFS_ERROR_INVALID 21U
#define LGFS_ERROR_UNSUPPORTED 22U

#define LGFS_WRITE_READ_ONLY 1U

#endif
