# S3 Sync

S3 Sync keeps Luker data in a shared, encrypted bucket so devices on different networks can work from the same copy. Everything is encrypted before upload.

Read the [Sync overview](./sync) for scheduling, categories, conflict decisions, chat branches and Undo.

## Prerequisites

- Upgrade every Luker installation that will share data.
- Create a bucket with your storage provider. Note its endpoint, region and path-style requirement.
- Give the credentials read and write access to the selected location, plus permission to delete the temporary objects used during setup. The provider must support conditional writes so concurrent changes cannot overwrite each other.
- Use the same bucket and normalized prefix on every device. Keep unrelated data in a separate location.
- Prefer HTTPS for both the browser-to-Luker connection and the Luker-to-storage connection. On a multi-user installation, a private endpoint also requires the administrator's [private-address policy](/guide/configuration#sync-private-addresses).

## Add storage

Open **User Settings → Account → Backup & Restore → Sync → Open Sync**, then choose **Add S3 backend**.

| Field | What to enter |
| --- | --- |
| **Backend label** | A name for this connection, such as Shared archive. |
| **Categories to sync** | The data to share; see [categories and sensitive data](./sync#categories-and-sensitive-data). |
| **S3 endpoint** | The provider's HTTP or HTTPS endpoint. Use HTTPS when available and keep credentials out of the URL. |
| **Region** | The region required by the provider. |
| **Bucket** | The existing bucket name. |
| **Prefix** | A location within the bucket, such as `seraphina/`, or blank for the bucket root. |
| **Use path-style requests** | Set according to the provider's addressing requirements. |
| **Send ETag without quotes** | Turn on when the provider accepts conditional writes but rejects a quoted ETag in If-Match. |
| **Access key ID**, **Secret access key** | The credential pair with access to this location. |
| **Encryption passphrase** | A phrase for a new sync location, or the existing phrase when joining one. |

Leading and trailing slashes in **Prefix** are ignored: `/seraphina/` and `seraphina` select the same location. Empty prefixes are valid. Empty inner segments, `.` or `..` segments, backslashes and control characters are rejected.

![Add S3 backend form with connection fields, categories and masked secrets](/images/sync/s3-form.png)

Choose **Save**. Setup verifies conditional-write support with temporary objects. A provider that ignores the required write conditions cannot be used. Setup also checks that the current ETag is accepted in If-Match; when a provider rejects only the quoted ETag, the error names **Send ETag without quotes**. Authentication failures, a missing bucket and connection failures are reported separately, so they are not mistaken for a compatibility problem.

The backend then appears under **Sync backends** and synchronization starts. See [activity and review](./sync#activity-and-review).

## Join from another device

On the joining device, choose **Add S3 backend** and enter the existing endpoint, region, bucket, normalized prefix, credentials and the **same encryption passphrase**. Select the categories to share and choose **Save**. Joining uses the passphrase field on this form; there is no separate prompt. A wrong phrase is rejected, and you can correct it and save again.

![Joining device's Add S3 form with the existing location and passphrase field](/images/sync/s3-second-device-passphrase.png)

Store the passphrase safely. Without it, a new installation cannot recover the encrypted data in the bucket. If recovery is impossible, start from data that still exists on a device and use a fresh, empty bucket or prefix. Removing a backend or starting another location does not decrypt the old data, so keep the existing encrypted data intact.

## Encryption and credentials

During setup, the browser sends the credentials and passphrase to your own Luker server. The server encrypts synchronized data before uploading it. The bucket holds only encrypted content and a public metadata record that does not contain the passphrase.

The server keeps the key material needed to unlock automatic sync, not the passphrase, so routine sync does not ask for it again. Backend lists and status responses do not return credentials or key material to the browser.

Bucket encryption does not protect endpoint credentials sent over HTTP. Protect both connections with HTTPS where available.

## Edit, remove and unlock

### Edit connection settings

Choose **Edit** on the backend row. Leave both credential fields and **Encryption passphrase** blank to keep the stored credentials and key. To replace credentials, fill in both fields; an incomplete replacement is rejected.

When you change the endpoint, region, path-style option, ETag quote option or credentials, Luker confirms that the new settings still reach the existing encrypted data before saving. The endpoint must still point to the same encrypted location. Entering a passphrase verifies that location's phrase; it does not change the phrase protecting the data.

**Bucket** and **Prefix** are read-only. To use a different location, **Remove** the backend and add it again. This creates a separate backend and sync history rather than moving the old one. **Remove** leaves the bucket data and other devices unchanged.

### Repair a stored key

Use **Unlock** when the error asks for the backend passphrase. Unlock repairs the stored key only when the local key record is valid and matches the remote data.

If the local record is missing or damaged, or the remote data now uses a different encryption identity, follow the error's instruction to **Remove** and re-add the backend. Unlock cannot adopt another identity or replace the encryption key. Restore missing or damaged encryption metadata from a valid copy; do not delete or overwrite it to force setup.

## Troubleshooting

| Reported problem | Action |
| --- | --- |
| The passphrase does not match this bucket and prefix | Check the location and use its original phrase. |
| Authentication failed | Check the credential pair and bucket permissions. |
| Bucket could not be found | Verify that it exists at the configured endpoint. |
| Endpoint could not be reached | Restore network or provider access, then check the endpoint and region. |
| Provider does not support conditional writes | Use a compatible storage service. |
| Provider rejects a quoted ETag in If-Match | Turn on **Send ETag without quotes** and save again. |
| Private-address connection is disabled | Ask an administrator to check the [private-address policy](/guide/configuration#sync-private-addresses). |
| Encryption format is unsupported | Update Luker, then sync again. |
| Sync data is missing or invalid | Restore the bucket's sync data from a valid copy, then sync again; see [recovery](./sync#undo-and-recovery). |

S3 Sync runs on desktop, Android and HarmonyOS. Keep the Luker server running and able to reach the storage service. Automatic retries follow the [normal sync triggers](./sync#automatic-sync-and-schedule).

Changing the passphrase, rotating keys and automatic history compaction are not supported. The first sync downloads the stored history, and bucket usage grows as history accumulates.
