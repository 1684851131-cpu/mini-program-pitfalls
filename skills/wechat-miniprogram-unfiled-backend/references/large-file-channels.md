# Choosing a transport for payloads

Three channels, one rule: **JSON for structured data, cloud storage for bytes.**

| Payload | Channel | Why |
|---|---|---|
| API request/response | JSON proxy | Simplest, preserves status codes |
| Avatar, receipt photo, ID scan | Cloud storage (`fileID`) | No per-call size limit, returns a permanent `cloud://` id |
| Batch images, exports | CDN marker (`fileCdn`) | Upload path outside `callFunction`, function only pulls a URL |
| Anything > ~1 MB | Throw | `callFunction` rejects the call outright |

## JSON channel

Client sends `{path, method, data, headers}`. `data` becomes the request body.

- Works for every normal API call.
- Response is parsed once and returned as `json`; non-JSON (file downloads) is dropped with `size` only.
- Base64 inside JSON is a trap: base64 inflates by ~33%, so the real ceiling is around 700 KB of
  original bytes. Compress first:

```ts
if (fileSize > 500 * 1024) {
  const c = await wx.compressImage({ src: filePath, quality: 70 });
  filePath = c.tempFilePath;
}
```

Use base64 only as a last resort for small images. It is slower and burns quota twice (invocation +
transfer).

## Cloud storage channel (`fileID`)

The right answer for user-supplied images on a real device.

```ts
// client
const cloud = getCloud();                        // native wx.cloud (or your framework's equivalent)
const up = await cloud.uploadFile({
  cloudPath: `avatars/${uid}_${Date.now()}.jpg`,
  filePath,                                      // temp path from chooseAvatar/chooseImage
});
await updateProfile({ avatar: up.fileID });      // cloud://<env>.<host>/avatars/x.jpg

// function: receives event.fileID, pulls the bytes, forwards them with the right content-type
```

Server side:

1. **Widen validators to accept `cloud://`**, otherwise `PUT /api/user/profile` silently drops the
   avatar and the user thinks the upload failed. The same regex is usually copy-pasted in several
   places (avatar check, profile update, document check) — fix them all.
2. **Render `cloud://` in web admin.** Browsers cannot open it. Add a resolver endpoint:
   `GET /api/file-url?fid=<cloud://…>` → call `tcb/batchdownloadfile` → `302` to the temporary HTTPS
   URL, cached in memory until just before expiry. Wrap every `<img>` source in an `imgSrc(v)` helper.
3. `cloud://` ids are scoped to one appid's environment. Switching env or appid invalidates them.

Why this matters: `<Image src="http://…">` is **rejected on a real device**
(`<wx-image>: 图片链接 http://... 不再支持 HTTP 协议`), while the developer tool renders it happily.
Any design that serves user photos from `http://IP:port` looks fine in dev and is broken on phones.

## CDN marker channel (`fileCdn`)

When the client can hand you a temporary HTTPS URL instead of bytes:

```ts
const { fileID } = await wx.cloud.CDN({ type: 'filePath', filePath });
// pass fileCdn: fileID (or the https url the SDK hands back)
```

The function downloads it, then forwards the bytes to the backend with the upstream content-type.
Good for bulk images; keeps `callFunction` payloads at a few hundred bytes.

## Anti-patterns

- Serving user photos over `http://IP:port` → works in devtool, blocked on device.
- Storing the base64 string in the database → breaks pagination and quotas.
- Re-uploading the same image on every page load → cache the `fileID` on the user/order record.
- Leaving old `http://` URLs in historical data → they cannot be repaired; re-upload is the only fix.
