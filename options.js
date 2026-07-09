(function () {
  'use strict';

  const newNameInput = document.getElementById('newPlaylistName');
  const createBtn = document.getElementById('createPlaylistBtn');
  createBtn.className = 'btn-primary';
  const playlistsContainer = document.getElementById('playlistsContainer');
  const exportBtn = document.getElementById('exportBtn');
  const importFile = document.getElementById('importFile');
  const importStatus = document.getElementById('importStatus');

  function isSystemPlaylist(playlist) {
    return typeof playlist.name === 'string' && playlist.name.startsWith('__dop_');
  }

  function formatRangeName(range) {
    if (range && range.name) return range.name;
    return '範囲';
  }

  function decodeHtmlEntities(str) {
    const txt = document.createElement('textarea');
    txt.innerHTML = str || '';
    return txt.value;
  }

  async function renderPlaylists() {
    const playlists = (await dopGetPlaylists()).filter((p) => !isSystemPlaylist(p));
    const collapsedState = await dopGetCollapsedPlaylists();
    playlistsContainer.innerHTML = '';

    if (playlists.length === 0) {
      playlistsContainer.innerHTML = `
        <div class="empty-state">
          <div class="empty-state-icon">♪</div>
          <div>プレイリストがありません。</div>
        </div>
      `;
      return;
    }

    playlists.forEach((playlist) => {
      const card = document.createElement('div');
      card.className = 'playlist-card';

      const header = document.createElement('div');
      header.className = 'playlist-header';

      const toggleGroup = document.createElement('span');
      toggleGroup.className = 'playlist-toggle-group';

      const toggleBtn = document.createElement('span');
      toggleBtn.className = 'playlist-toggle';
      toggleBtn.textContent = collapsedState[playlist.id] !== false ? '\u25B6' : '\u25BC';

      const count = document.createElement('span');
      count.className = 'playlist-count';
      count.textContent = `${playlist.items.length}件`;

      toggleGroup.appendChild(toggleBtn);
      toggleGroup.appendChild(count);

      const nameInput = document.createElement('input');
      nameInput.type = 'text';
      nameInput.value = playlist.name;
      nameInput.className = 'playlist-name-input';
      nameInput.addEventListener('change', () => dopRenamePlaylist(playlist.id, nameInput.value));

      const actions = document.createElement('div');
      actions.className = 'playlist-actions';

      const playBtn = document.createElement('button');
      playBtn.textContent = '▶ 再生';
      playBtn.className = 'btn-text';
      playBtn.addEventListener('click', () => startPlaylistPlayback(playlist.id));

      const deleteBtn = document.createElement('button');
      deleteBtn.textContent = '削除';
      deleteBtn.className = 'btn-danger-text';
      deleteBtn.addEventListener('click', async () => {
        await dopDeletePlaylist(playlist.id);
        renderPlaylists();
      });

      actions.appendChild(playBtn);
      actions.appendChild(deleteBtn);
      header.appendChild(toggleGroup);
      header.appendChild(nameInput);
      header.appendChild(actions);
      card.appendChild(header);

      header.addEventListener('click', (e) => {
        if (e.target.closest('input, button')) return;
        const collapsed = card.classList.toggle('collapsed');
        toggleBtn.textContent = collapsed ? '\u25B6' : '\u25BC';
        dopSetCollapsedPlaylist(playlist.id, collapsed);
      });

      const itemsList = document.createElement('ol');
      itemsList.className = 'items-list';
      playlist.items.forEach((item, idx) => {
        const li = document.createElement('li');
        li.className = 'item-row';

        const info = document.createElement('div');
        info.className = 'item-info';

        const episodeNum = item.episodeNumber || extractEpisodeNumber(item.episodeTitle);

        const title = document.createElement('div');
        title.className = 'item-title';
        if (episodeNum) {
          title.textContent = decodeHtmlEntities(episodeNum) + ' - ' + (decodeHtmlEntities(item.title) || '(タイトル不明)');
        } else {
          title.textContent = decodeHtmlEntities(item.title) || '(タイトル不明)';
        }

        let episodeSub = null;
        if (!episodeNum && item.episodeTitle) {
          episodeSub = document.createElement('div');
          episodeSub.className = 'item-episode';
          episodeSub.textContent = decodeHtmlEntities(item.episodeTitle);
        }

        const meta = document.createElement('div');
        meta.className = 'item-meta';

        const rangeNameEl = document.createElement('span');
        rangeNameEl.className = 'item-range-name';
        rangeNameEl.textContent = item.range ? formatRangeName(item.range) : '範囲未設定';
        meta.appendChild(rangeNameEl);

        if (item.range) {
          const timeEl = document.createElement('span');
          timeEl.className = 'item-range-time';
          timeEl.textContent = `${formatSec(item.range.start)}-${formatSec(item.range.end)}`;
          meta.appendChild(timeEl);
        }

        const editRow = document.createElement('div');
        editRow.className = 'item-edit-row';
        editRow.style.display = 'none';

        const titleInput = document.createElement('input');
        titleInput.type = 'text';
        titleInput.className = 'item-title-input';
        titleInput.value = item.range ? (item.range.name || formatRangeName(item.range)) : '';
        titleInput.placeholder = 'タイトル';
        titleInput.disabled = !item.range;

        const startInput = document.createElement('input');
        startInput.type = 'text';
        startInput.className = 'item-time-input';
        startInput.value = item.range ? formatSec(item.range.start) : '';
        startInput.placeholder = '開始';
        startInput.disabled = !item.range;

        const endInput = document.createElement('input');
        endInput.type = 'text';
        endInput.className = 'item-time-input';
        endInput.value = item.range ? formatSec(item.range.end) : '';
        endInput.placeholder = '終了';
        endInput.disabled = !item.range;

        const saveBtn = document.createElement('button');
        saveBtn.textContent = '保存';
        saveBtn.className = 'btn-primary';
        saveBtn.disabled = !item.range;
        saveBtn.addEventListener('click', async () => {
          const startMs = parseTimeInput(startInput.value);
          const endMs = parseTimeInput(endInput.value);
          if (startMs === null || endMs === null || startMs >= endMs) {
            showStatus('開始・終了時間を正しく入力してください。');
            return;
          }
          const playlists = await dopGetPlaylists();
          const p = playlists.find((pl) => pl.id === playlist.id);
          const target = p && p.items.find((i) => i.id === item.id);
          if (target && target.range) {
            const newName = titleInput.value.trim();
            target.range.name = newName || undefined;
            target.range.start = startMs;
            target.range.end = endMs;
            await dopSavePlaylists(playlists);
            showStatus('保存しました。');
            renderPlaylists();
          }
        });

        const cancelBtn = document.createElement('button');
        cancelBtn.className = 'btn-text';
        cancelBtn.textContent = 'キャンセル';
        cancelBtn.addEventListener('click', () => {
          editRow.classList.remove('open');
          meta.style.display = '';
        });

        editRow.appendChild(titleInput);
        editRow.appendChild(startInput);
        editRow.appendChild(document.createTextNode(' - '));
        editRow.appendChild(endInput);
        editRow.appendChild(saveBtn);
        editRow.appendChild(cancelBtn);

        info.appendChild(title);
        if (episodeSub) info.appendChild(episodeSub);
        info.appendChild(meta);
        info.appendChild(editRow);

        const controls = document.createElement('div');
        controls.className = 'item-controls';

        const playBtn = document.createElement('button');
        playBtn.textContent = '▶';
        playBtn.title = '再生';
        playBtn.className = 'btn-icon';
        playBtn.addEventListener('click', () => startPlaylistPlayback(playlist.id, idx));

        const editBtn = document.createElement('button');
        editBtn.textContent = '編集';
        editBtn.className = 'btn-text';
        editBtn.disabled = !item.range;
        editBtn.addEventListener('click', () => {
          editRow.classList.add('open');
          meta.style.display = 'none';
        });

        const copyBtn = document.createElement('button');
        copyBtn.textContent = 'コピー';
        copyBtn.className = 'btn-text';
        copyBtn.addEventListener('click', async () => {
          const targetId = await showCopyDialog(playlists, playlist.id);
          if (!targetId) return;
          await dopCopyItemToPlaylist(targetId, item);
          showStatus('コピーしました。');
          renderPlaylists();
        });

        const removeBtn = document.createElement('button');
        removeBtn.textContent = '削除';
        removeBtn.className = 'btn-danger-text';
        removeBtn.addEventListener('click', async () => {
          await dopRemoveItem(playlist.id, item.id);
          renderPlaylists();
        });

        function addDivider() {
          const divider = document.createElement('span');
          divider.className = 'divider';
          controls.appendChild(divider);
        }

        controls.appendChild(playBtn);
        addDivider();
        controls.appendChild(editBtn);
        controls.appendChild(copyBtn);
        addDivider();
        controls.appendChild(removeBtn);
        li.appendChild(info);
        li.appendChild(controls);
        li.draggable = true;
        li.dataset.itemId = item.id;
        itemsList.appendChild(li);
      });

      let dragSrcItemId = null;
      itemsList.addEventListener('dragstart', (e) => {
        const row = e.target.closest('.item-row');
        if (!row) return;
        dragSrcItemId = row.dataset.itemId;
        row.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', dragSrcItemId);
      });
      itemsList.addEventListener('dragend', (e) => {
        const row = e.target.closest('.item-row');
        if (row) row.classList.remove('dragging');
        itemsList.querySelectorAll('.item-row').forEach((r) => r.classList.remove('drag-over'));
        dragSrcItemId = null;
      });
      itemsList.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        const row = e.target.closest('.item-row');
        itemsList.querySelectorAll('.item-row').forEach((r) => r.classList.remove('drag-over'));
        if (row && row.dataset.itemId !== dragSrcItemId) {
          row.classList.add('drag-over');
        }
      });
      itemsList.addEventListener('drop', async (e) => {
        e.preventDefault();
        const row = e.target.closest('.item-row');
        itemsList.querySelectorAll('.item-row').forEach((r) => r.classList.remove('drag-over'));
        if (!row || !dragSrcItemId || row.dataset.itemId === dragSrcItemId) return;
        const playlists = await dopGetPlaylists();
        const pl = playlists.find((p) => p.id === playlist.id);
        if (!pl) return;
        const srcIdx = pl.items.findIndex((i) => i.id === dragSrcItemId);
        const dstIdx = pl.items.findIndex((i) => i.id === row.dataset.itemId);
        if (srcIdx < 0 || dstIdx < 0 || srcIdx === dstIdx) return;
        const [moved] = pl.items.splice(srcIdx, 1);
        pl.items.splice(dstIdx, 0, moved);
        await dopSavePlaylists(playlists);
        dragSrcItemId = null;
        renderPlaylists();
      });

      const itemsWrapper = document.createElement('div');
      itemsWrapper.className = 'playlist-items-wrapper';
      itemsWrapper.appendChild(itemsList);

      if (collapsedState[playlist.id] !== false) {
        card.classList.add('collapsed');
      }

      card.appendChild(itemsWrapper);
      playlistsContainer.appendChild(card);
    });
  }

  function formatSec(ms) {
    const s = Math.floor(ms / 1000);
    const m = Math.floor(s / 60);
    const sec = s % 60;
    return `${m}:${String(sec).padStart(2, '0')}`;
  }

  function showCopyDialog(playlists, currentPlaylistId) {
    return new Promise((resolve) => {
      let modal = document.getElementById('d-op-copy-modal');
      if (modal) modal.remove();

      modal = document.createElement('div');
      modal.id = 'd-op-copy-modal';
      modal.className = 'd-op-modal';

      const panel = document.createElement('div');
      panel.className = 'd-op-modal-panel';

      const h3 = document.createElement('h3');
      h3.textContent = 'コピー先のプレイリスト';
      panel.appendChild(h3);

      const targets = playlists.filter((p) => !isSystemPlaylist(p) && p.id !== currentPlaylistId);
      if (targets.length === 0) {
        const empty = document.createElement('p');
        empty.textContent = 'コピー先がありません。';
        panel.appendChild(empty);
      } else {
        const list = document.createElement('div');
        list.className = 'd-op-modal-playlist-list';
        targets.forEach((p) => {
          const row = document.createElement('button');
          row.className = 'd-op-modal-playlist-item';
          row.textContent = `${p.name} (${p.items.length}曲)`;
          row.addEventListener('click', () => {
            modal.remove();
            resolve(p.id);
          });
          list.appendChild(row);
        });
        panel.appendChild(list);
      }

      const footer = document.createElement('div');
      footer.className = 'd-op-modal-footer';
      const cancelBtn = document.createElement('button');
      cancelBtn.textContent = 'キャンセル';
      cancelBtn.className = 'btn-text';
      cancelBtn.addEventListener('click', () => {
        modal.remove();
        resolve(null);
      });
      footer.appendChild(cancelBtn);
      panel.appendChild(footer);

      modal.appendChild(panel);
      modal.addEventListener('click', (e) => {
        if (e.target === modal) {
          modal.remove();
          resolve(null);
        }
      });
      document.body.appendChild(modal);
    });
  }

  async function startPlaylistPlayback(playlistId, index = 0) {
    const playlists = await dopGetPlaylists();
    const playlist = playlists.find((p) => p.id === playlistId);
    if (!playlist || playlist.items.length === 0) {
      showStatus('プレイリストが空です。');
      return;
    }
    const item = playlist.items[index];
    if (!item || !item.range) {
      showStatus('選択したアイテムに範囲が設定されていません。');
      return;
    }
    await dopSetPlayback({ playlistId, index, updatedAt: Date.now() });
    await dopClearPending();
    const url = new URL(item.url);
    url.searchParams.set('dopPlaylistId', playlistId);
    url.searchParams.set('dopIndex', String(index));
    chrome.runtime.sendMessage({ type: 'REQUEST_PLAYER', url: url.toString() });
  }

  function parseTimeInput(str) {
    if (!str) return null;
    const parts = String(str).trim().split(':');
    if (parts.length === 2) {
      const m = parseInt(parts[0], 10);
      const s = parseInt(parts[1], 10);
      if (!isNaN(m) && !isNaN(s)) return (m * 60 + s) * 1000;
    }
    const sec = parseFloat(str);
    if (!isNaN(sec)) return Math.floor(sec * 1000);
    return null;
  }

  function showStatus(text, type = 'success') {
    importStatus.textContent = text;
    importStatus.className = type === 'error' ? 'error' : 'success';
    setTimeout(() => {
      importStatus.textContent = '';
      importStatus.className = '';
    }, 3000);
  }

  createBtn.addEventListener('click', async () => {
    const name = newNameInput.value.trim();
    if (!name) return;
    await dopCreatePlaylist(name);
    newNameInput.value = '';
    renderPlaylists();
  });

  exportBtn.className = 'btn-secondary';
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
          range: i.range ? { ...i.range } : null
        })) : []
      }));
      await dopSavePlaylists(cleaned);
      renderPlaylists();
      showStatus('インポートしました。');
    } catch (err) {
      showStatus('インポートに失敗しました: ' + err.message, 'error');
    }
    e.target.value = '';
  });

  function initWindowModeSetting() {
    const radios = document.querySelectorAll('input[name="windowMode"]');
    if (radios.length === 0) return;
    dopGetWindowMode().then((mode) => {
      const target = document.querySelector(`input[name="windowMode"][value="${mode}"]`);
      if (target) target.checked = true;
    });
    radios.forEach((radio) => {
      radio.addEventListener('change', () => {
        if (radio.checked) dopSetWindowMode(radio.value);
      });
    });
  }

  renderPlaylists();
  initWindowModeSetting();
})();
