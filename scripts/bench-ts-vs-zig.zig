const std = @import("std");
const linux = std.os.linux;

const AT_FDCWD: i32 = linux.AT.FDCWD;
const AT_SYMLINK_NOFOLLOW: u32 = linux.AT.SYMLINK_NOFOLLOW;

export fn noop(a: i32) i32 {
    return a;
}

export fn lowerIncludes(hay: [*]const u8, hayLen: usize, needle: [*]const u8, needleLen: usize) u8 {
    if (needleLen == 0) return 1;
    if (needleLen > hayLen) return 0;
    // Lower the needle once up front (queries are short); fall back to
    // on-the-fly lowering for pathological lengths.
    var lowered: [512]u8 = undefined;
    var nd: []const u8 = needle[0..needleLen];
    var prelowered = false;
    if (needleLen <= lowered.len) {
        for (needle[0..needleLen], 0..) |b, idx| {
            lowered[idx] = if (b >= 'A' and b <= 'Z') b + 32 else b;
        }
        nd = lowered[0..needleLen];
        prelowered = true;
    }
    var i: usize = 0;
    while (i + needleLen <= hayLen) : (i += 1) {
        var ok = true;
        var j: usize = 0;
        while (j < needleLen) : (j += 1) {
            var a = hay[i + j];
            if (a >= 'A' and a <= 'Z') a += 32;
            var b = nd[j];
            if (!prelowered and b >= 'A' and b <= 'Z') b += 32;
            if (a != b) {
                ok = false;
                break;
            }
        }
        if (ok) return 1;
    }
    return 0;
}

export fn extLen(name: [*]const u8, nameLen: usize) usize {
    const s = name[0..nameLen];
    const dot = std.mem.lastIndexOfScalar(u8, s, '.') orelse return 0;
    if (dot == 0) return 0;
    return nameLen - dot - 1;
}

export fn fnv1a64(ptr: [*]const u8, len: usize) u64 {
    var h: u64 = 0xcbf29ce484222325;
    for (ptr[0..len]) |b| {
        h ^= b;
        h = h *% 0x100000001b3;
    }
    return h;
}

export fn strCmp(a: [*]const u8, aLen: usize, b: [*]const u8, bLen: usize) i32 {
    const n = @min(aLen, bLen);
    var i: usize = 0;
    while (i < n) : (i += 1) {
        if (a[i] != b[i]) return if (a[i] < b[i]) @as(i32, -1) else @as(i32, 1);
    }
    if (aLen == bLen) return 0;
    return if (aLen < bLen) @as(i32, -1) else @as(i32, 1);
}

fn isErr(r: usize) bool {
    return @as(isize, @bitCast(r)) < 0;
}

fn openDirFd(pathPtr: [*]const u8, pathLen: usize, pathBuf: *[4096]u8) i32 {
    if (pathLen == 0 or pathLen >= 4095) return -1;
    @memcpy(pathBuf[0..pathLen], pathPtr[0..pathLen]);
    pathBuf[pathLen] = 0;
    const zpath: [*:0]const u8 = @ptrCast(pathBuf);
    const r = linux.openat(AT_FDCWD, zpath, .{ .ACCMODE = .RDONLY, .DIRECTORY = true, .CLOEXEC = true }, 0);
    if (isErr(r)) return -1;
    return @as(i32, @intCast(@as(isize, @bitCast(r))));
}

// Bulk readdir: count entries via getdents64 (skips . and ..). Mirrors scanDir.
export fn scanCount(pathPtr: [*]const u8, pathLen: usize) usize {
    var pathBuf: [4096]u8 = undefined;
    const fd = openDirFd(pathPtr, pathLen, &pathBuf);
    if (fd < 0) return 0;
    defer _ = linux.close(fd);
    var buf: [8192]u8 = undefined;
    var n: usize = 0;
    while (true) {
        const r = linux.getdents64(fd, &buf, buf.len);
        if (isErr(r) or r == 0) break;
        var off: usize = 0;
        while (off < r) {
            const d: *align(1) linux.dirent64 = @ptrCast(@alignCast(&buf[off]));
            const reclen: usize = d.reclen;
            if (reclen == 0) break;
            const namePtr: [*:0]const u8 = @ptrCast(&d.name);
            const nameLen = std.mem.len(namePtr);
            if (!((nameLen == 1 and namePtr[0] == '.') or (nameLen == 2 and namePtr[0] == '.' and namePtr[1] == '.'))) {
                n += 1;
            }
            off += reclen;
        }
    }
    return n;
}

// Bulk scan+stat: count entries and sum sizes via statx (lstat semantics).
export fn scanStatSum(pathPtr: [*]const u8, pathLen: usize, outCount: *usize) u64 {
    var pathBuf: [4096]u8 = undefined;
    const fd = openDirFd(pathPtr, pathLen, &pathBuf);
    if (fd < 0) {
        outCount.* = 0;
        return 0;
    }
    defer _ = linux.close(fd);
    var buf: [8192]u8 = undefined;
    var n: usize = 0;
    var sum: u64 = 0;
    while (true) {
        const r = linux.getdents64(fd, &buf, buf.len);
        if (isErr(r) or r == 0) break;
        var off: usize = 0;
        while (off < r) {
            const d: *align(1) linux.dirent64 = @ptrCast(@alignCast(&buf[off]));
            const reclen: usize = d.reclen;
            if (reclen == 0) break;
            const namePtr: [*:0]const u8 = @ptrCast(&d.name);
            const nameLen = std.mem.len(namePtr);
            if (!((nameLen == 1 and namePtr[0] == '.') or (nameLen == 2 and namePtr[0] == '.' and namePtr[1] == '.'))) {
                n += 1;
                const zname: [*:0]const u8 = @ptrCast(namePtr);
                var stx: linux.Statx = undefined;
                const sr = linux.statx(fd, zname, AT_SYMLINK_NOFOLLOW, linux.STATX.BASIC_STATS, &stx);
                if (!isErr(sr)) sum += stx.size;
            }
            off += reclen;
        }
    }
    outCount.* = n;
    return sum;
}
