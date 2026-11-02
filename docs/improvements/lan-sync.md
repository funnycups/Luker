# LAN Sync

Pair reachable Luker servers for direct synchronization. For automatic sync, categories, version decisions, chat branches and Undo, see the [Sync overview](./sync). For a storage hub shared across networks, see [S3 Sync](./s3-sync).

## Prerequisites

- Upgrade **both ends** before syncing. The older protocol is not supported. Valid existing pairs migrate on upgrade and do not need to be paired again.
- Keep both Luker servers running and reachable from each other. A browser reaching the other server is not sufficient if the reverse server connection is blocked.
- Enable LAN listening on both servers and allow their ports through firewalls and IP whitelists. See [Configuration](/guide/configuration) for `listen`, listening addresses and access protection.
- Use the same account handle on both installations. Display names are not the account handle.
- On a multi-user server, ask the administrator to permit private destinations for non-admin accounts through the [private-address policy](/guide/configuration#sync-private-addresses).

Use addresses reachable from the other device, not `localhost` or `127.0.0.1`. Without TLS, transferred data is unencrypted on the network; use a trusted network or an HTTPS connection.

## Generate a pairing link

On the device sharing the link, open **User Settings → Account → Backup & Restore → Sync → Open Sync**, then **Pair new device**.

Enter a label for the other device, select **Categories to sync:** and choose **Generate pairing link**. The [category reference](./sync#categories-and-sensitive-data) explains defaults and sensitive selections.

![Pair new device form with Tablet and selected categories](/images/sync/02-pair-new-form-filled.png)

Under **Address the other device will use**, select the reachable address. Luker prefers a detected non-loopback address when available; select another if the server has several network interfaces. Choose **Copy link** and send the link privately to the device being paired.

![Generated link with address selection and credential-storage guidance](/images/sync/03-pair-link-generated.png)

The link contains a one-time pairing code valid for **10 minutes**. If it expires, choose **Generate another** and generate a new link. A failed reverse-connection check leaves the same unexpired link usable after the connection is corrected.

## Accept the link

On the receiving device, open the same Sync panel and choose **Pair with existing device**. Paste the **Pairing link**. Check **Other device base URL**, **Peer identifier from the other device**, **Label for the other device** and the selected categories. Set the label to the device this connection reaches, such as Desk.

If the other device requires Basic authentication, fill its expected username and password in the optional fields; otherwise leave them blank. After pairing, entered credentials are stored on this accepting device's Luker server for future syncs. Use **Clear credentials** on this device's backend row to remove them.

![Pasted pairing link with peer fields, optional credentials and Pair and sync](/images/sync/04-pair-existing-pasted.png)

Choose **Pair and sync**. The devices exchange the selected data. The success banner names the paired backend; a warning can instead indicate pending decisions to review in the [Sync overview](./sync#pending-decisions).

![Successful sync with Desk after pairing](/images/sync/05-pair-success-banner.png)

The saved connection appears under **Sync backends**. Normal automatic triggers continue afterward; use **Sync now** when needed.

## Pairing and connection problems

| Result | Action |
| --- | --- |
| `PEER_CALLBACK_UNREACHABLE`: the other device cannot connect back | Enable LAN listening on the accepting device, check its firewall and retry the same valid link. This error is a rejected pairing, not a saved successful pair. |
| **Paired with …, but the first sync failed: …** | The connection was saved. Correct the reported cause and use **Sync now** on that backend. |
| `NO_BASE_URL`: the other device's address is not known yet | Start a sync from the other end so it supplies its reachable address. |
| `PEER_PROTOCOL_OUTDATED` | Upgrade the other Luker server, then sync again. |
| `PEER_FORGOTTEN`, or an invalid old pairing identifier | Remove the affected local connection and pair again. This is separate from a valid pair's normal upgrade migration. |
| Authentication failure | Check the expected Basic-auth credentials when pairing. For a saved connection whose credentials changed, remove and pair again as the error directs. |
| Account-handle mismatch | Sign in to matching handles before accepting the link. |
| Private-address rejection | Ask the administrator about the [private-address policy](/guide/configuration#sync-private-addresses). Listening and firewall access are separate requirements. |
| `SYNC_BACKEND_MAINTENANCE` | The other device is updating sync settings. Allow it to finish, then use **Sync now** or wait for a later normal trigger. |
| Other reachability error | Check both servers, the selected address, port, routing, firewall and whitelist, then sync again. |
