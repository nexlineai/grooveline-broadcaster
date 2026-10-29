// 1.6.0 test helper: a signed-in DJ with one slot, the booking API mocked in the main process (no prod calls).
// The slot's radio and video addresses point at local fakes (fake-icecast.py :18999, an ffmpeg RTMP sink :19935).
// serverShiftMin moves the server clock (the API's Date header) against this computer's.
export async function mockSlot(app, w, { type = 'icecast', mount = '/live-test', server = '127.0.0.1:18999', rtmpUrl = 'rtmp://127.0.0.1:19935/live/zdb-test1234',
  startMin = -5, endMin = 60, serverShiftMin = 0, id } = {}) {
  const now = Date.now();
  const a = { type, mount, server, rtmpUrl, id: id || 'bk-' + type + '-' + startMin,
    start: new Date(now + startMin * 60e3).toISOString(), end: new Date(now + endMin * 60e3).toISOString(), shift: serverShiftMin * 60e3 };
  await app.evaluate(({ ipcMain }, a) => {
    const date = () => new Date(Date.now() + a.shift).toUTCString();
    for (const ch of ['api-me', 'api-bookings', 'api-credentials']) ipcMain.removeHandler(ch);
    ipcMain.handle('api-me', async () => ({ status: 200, date: date(), body: { dj_name: 'testdj', email: 'test@example.com', tier: 'pro' } }));
    ipcMain.handle('api-bookings', async () => ({ status: 200, date: date(), body: { bookings: [{ id: a.id, slot_start: a.start, slot_end: a.end, status: 'confirmed', stream_type: a.type, mount_point: a.mount }] } }));
    ipcMain.handle('api-credentials', async () => ({ status: 200, date: date(), body: { server: a.server, port: 8000, mount_point: a.mount, username: 'source', password: 'smokepw123',
      slot_start: a.start, slot_end: a.end, stream_type: a.type, stream_key: a.type === 'rtmp' ? 'zdb-test1234' : 'zdb-unused99', rtmp_url: a.type === 'rtmp' ? a.rtmpUrl : null } }));
  }, a);
  await w.evaluate(async () => { acctToken = 'fake-token-123456'; cfg._acctToken = acctToken; acctUser = { dj_name: 'testdj', email: 'test@example.com' }; acctShowLoggedIn(); await acctFetchBookings(); refreshUI(); });
}
// Change what the credentials endpoint answers from now on (the next load, e.g. at GO LIVE).
export async function remockCredentials(app, patch) {
  await app.evaluate(({ ipcMain }, patch) => {
    ipcMain.removeHandler('api-credentials');
    ipcMain.handle('api-credentials', async () => ({ status: 200, date: new Date().toUTCString(), body: { port: 8000, username: 'source', password: 'smokepw123', ...patch } }));
  }, patch);
}
