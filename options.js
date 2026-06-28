(function () {
  'use strict';

  const newNameInput = document.getElementById('newPlaylistName');
  const createBtn = document.getElementById('createPlaylistBtn');
  const playlistsContainer = document.getElementById('playlistsContainer');
  const playMode = document.getElementById('playMode');
  const exportBtn = document.getElementById('exportBtn');
  const importFile = document.getElementById('importFile');
  const importStatus = document.getElementById('importStatus');

  function isSystemPlaylist(playlist) {
    return typeof playlist.name === 'string' && playlist.name.startsWith('__dop_');
  }

  async function renderPlaylists() {
    const playlists = (await dopGetPlaylists()).filter((p) => !isSystemPlaylist(p));
    playlistsContainer.innerHTML = '';

    if (playlists.length === 0) {
      playlistsContainer.textContent = 'プレイリストがありません。';
      return;
    }

    playlists.forEach((playlist) => {
      const card = document.createElement('div');
      card.className = 'playlist-card';

      const header = document.createElement('div');
      header.className = 'playlist-header';

      const nameInput = document.createElement('input');
      nameInput.type = 'text';
      nameInput.value = playlist.name;
      nameInput.className = 'playlist-name-input';
      nameInput.addEventListener('change', () => dopRenamePlaylist(playlist.id, nameInput.value));

      const actions = document.createElement('div');
      actions.className = 'playlist-actions';

      const playBtn = document.createElement('button');
      playBtn.textContent = '再生';
      playBtn.addEventListener('click', () => startPlaylistPlayback(playlist.id));

      const deleteBtn = document.createElement('button');
      deleteBtn.textContent = '削除';
      deleteBtn.className = 'danger';
      deleteBtn.addEventListener('click', async () => {
        await dopDeletePlaylist(playlist.id);
        renderPlaylists();
      });

      actions.appendChild(playBtn);
      actions.appendChild(deleteBtn);
      header.appendChild(nameInput);
      header.appendChild(actions);
      card.appendChild(header);

      const itemsList = document.createElement('ol');
      itemsList.className = 'items-list';
      playlist.items.forEach((item, idx) => {
        const li = document.createElement('li');
        li.className = 'item-row';

        const info = document.createElement('div');
        info.className = 'item-info';

        const title = document.createElement('div');
        title.className = 'item-title';
        title.textContent = item.title || item.episodeTitle || '(タイトル不明)';

        const meta = document.createElement('div');
        meta.className = 'item-meta';
        const labels = [];
        if (item.opRange) labels.push(`OP ${formatSec(item.opRange.start)}-${formatSec(item.opRange.end)}`);
        if (item.edRange) labels.push(`ED ${formatSec(item.edRange.start)}-${formatSec(item.edRange.end)}`);
        if (item.customRange) labels.push(`CUSTOM ${formatSec(item.customRange.start)}-${formatSec(item.customRange.end)}`);
        meta.textContent = labels.join(' / ') || '範囲未設定';

        info.appendChild(title);
        info.appendChild(meta);

        const controls = document.createElement('div');
        controls.className = 'item-controls';

        const upBtn = document.createElement('button');
        upBtn.textContent = '↑';
        upBtn.disabled = idx === 0;
        upBtn.addEventListener('click', async () => {
          await dopMoveItem(playlist.id, item.id, -1);
          renderPlaylists();
        });

        const downBtn = document.createElement('button');
        downBtn.textContent = '↓';
        downBtn.disabled = idx === playlist.items.length - 1;
        downBtn.addEventListener('click', async () => {
          await dopMoveItem(playlist.id, item.id, 1);
          renderPlaylists();
        });

        const removeBtn = document.createElement('button');
        removeBtn.textContent = '削除';
        removeBtn.addEventListener('click', async () => {
          await dopRemoveItem(playlist.id, item.id);
          renderPlaylists();
        });

        controls.appendChild(upBtn);
        controls.appendChild(downBtn);
        controls.appendChild(removeBtn);
        li.appendChild(info);
        li.appendChild(controls);
        itemsList.appendChild(li);
      });

      card.appendChild(itemsList);
      playlistsContainer.appendChild(card);
    });
  }

  function formatSec(ms) {
    const s = Math.floor(ms / 1000);
    const m = Math.floor(s / 60);
    const sec = s % 60;
    return `${m}:${String(sec).padStart(2, '0')}`;
  }

  async function startPlaylistPlayback(playlistId) {
    const playlists = await dopGetPlaylists();
    const playlist = playlists.find((p) => p.id === playlistId);
    if (!playlist || playlist.items.length === 0) {
      showStatus('プレイリストが空です。');
      return;
    }
    const mode = playMode.value;
    await dopSetPlayback({ playlistId, index: 0, mode });
    const item = playlist.items[0];
    chrome.tabs.create({ url: item.url, active: true });
  }

  function showStatus(text) {
    importStatus.textContent = text;
    setTimeout(() => {
      importStatus.textContent = '';
    }, 3000);
  }

  createBtn.addEventListener('click', async () => {
    const name = newNameInput.value.trim();
    if (!name) return;
    await dopCreatePlaylist(name);
    newNameInput.value = '';
    renderPlaylists();
  });

  exportBtn.addEventListener('click', async () => {
    const playlists = await dopGetPlaylists();
    const blob = new Blob([JSON.stringify(playlists, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `dop_playlists_${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
    showStatus('エクスポートしました。');
  });

  importFile.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      if (!Array.isArray(data)) throw new Error('invalid format');
      const cleaned = data.map((p) => ({
        id: p.id || dopGenerateId(),
        name: p.name || 'imported',
        items: Array.isArray(p.items) ? p.items.map((i) => ({
          id: i.id || dopGenerateId(),
          partId: i.partId || '',
          workId: i.workId || '',
          title: i.title || i.episodeTitle || '',
          episodeTitle: i.episodeTitle || '',
          url: i.url || '',
          opRange: i.opRange || null,
          edRange: i.edRange || null,
          customRange: i.customRange || null
        })) : []
      }));
      await dopSavePlaylists(cleaned);
      renderPlaylists();
      showStatus('インポートしました。');
    } catch (err) {
      showStatus('インポートに失敗しました: ' + err.message);
    }
    e.target.value = '';
  });

  renderPlaylists();
})();
