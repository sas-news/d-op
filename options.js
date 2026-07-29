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
      toggleBtn.textContent = '\u25B6';
      if (collapsedState[playlist.id] === false) toggleBtn.classList.add('expanded');

      const count = document.createElement('span');
      count.className = 'playlist-count';
      const totalMs = playlist.items.reduce((s, it) => it.range ? s + (it.range.end - it.range.start) : s, 0);
      count.textContent = `${playlist.items.length}件 / ${formatSec(totalMs)}`;

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
        const ok = await showConfirm(`プレイリスト「${playlist.name}」を削除しますか？`);
        if (!ok) return;
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
        toggleBtn.classList.toggle('expanded', !collapsed);
        dopSetCollapsedPlaylist(playlist.id, collapsed);
      });

      const itemsList = document.createElement('ol');
      itemsList.className = 'items-list';
      playlist.items.forEach((item, idx) => {
        const li = document.createElement('li');
        li.className = 'item-row';

        const info = document.createElement('div');
        info.className = 'item-info';

        const epNum = item.episodeNumber ? decodeHtmlEntities(item.episodeNumber) : '';
        const epTitle = item.episodeTitle ? decodeHtmlEntities(item.episodeTitle) : '';
        const workTitle = decodeHtmlEntities(item.title) || '';

        const title = document.createElement('div');
        title.className = 'item-episode';
        title.textContent = [epNum, epTitle].filter(Boolean).join(' ') || workTitle || '(タイトル不明)';

        const episodeSub = document.createElement('div');
        episodeSub.className = 'item-work';
        episodeSub.textContent = workTitle;

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
        info.appendChild(episodeSub);
        info.appendChild(meta);
        info.appendChild(editRow);

        const controls = document.createElement('div');
        controls.className = 'item-controls';

        const playBtn = document.createElement('button');
        playBtn.textContent = '▶';
        playBtn.title = '再生';
        playBtn.className = 'btn-icon';
        playBtn.addEventListener('click', async () => {
          const pls = await dopGetPlaylists();
          const pl = pls.find((p) => p.id === playlist.id);
          if (!pl) return;
          const itemIdx = pl.items.findIndex((i) => i.id === item.id);
          if (itemIdx >= 0) startPlaylistPlayback(playlist.id, itemIdx);
        });

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
          const ok = await showConfirm('このアイテムを削除しますか？');
          if (!ok) return;
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

        const grip = document.createElement('div');
        grip.className = 'drag-grip';
        for (let i = 0; i < 3; i++) {
          const line = document.createElement('div');
          line.className = 'drag-grip-line';
          grip.appendChild(line);
        }

        li.appendChild(grip);
        li.appendChild(info);
        li.appendChild(controls);
        li.dataset.itemId = item.id;
        itemsList.appendChild(li);
      });

      let dragState = null;

      function flipAnimate(listEl, skipRow) {
        const rows = [...listEl.querySelectorAll('.item-row')];
        const firsts = {};
        rows.forEach((r) => { firsts[r.dataset.itemId] = r.getBoundingClientRect().top; });
        return () => {
          const newRows = [...listEl.querySelectorAll('.item-row')];
          newRows.forEach((r) => {
            if (r === skipRow) return;
            const prev = firsts[r.dataset.itemId];
            if (prev === undefined) return;
            const curr = r.getBoundingClientRect().top;
            const diff = prev - curr;
            if (Math.abs(diff) > 0.5) {
              r.style.transform = `translateY(${diff}px)`;
              r.style.transition = 'none';
              void r.offsetHeight;
              r.style.transition = 'transform 120ms ease-out';
              r.style.transform = '';
            }
          });
        };
      }

      itemsList.addEventListener('mousedown', (e) => {
        const grip = e.target.closest('.drag-grip');
        if (!grip) return;
        e.preventDefault();
        const row = grip.closest('.item-row');
        if (!row) return;

        const rowRect = row.getBoundingClientRect();
        const clone = row.cloneNode(true);
        clone.classList.add('drag-clone');
        clone.style.width = rowRect.width + 'px';
        clone.style.left = rowRect.left + 'px';
        clone.style.top = rowRect.top + 'px';
        document.body.appendChild(clone);

        row.classList.add('dragging');

        dragState = {
          row,
          clone,
          playlistId: playlist.id,
          offsetY: e.clientY - rowRect.top,
          lastTarget: null
        };
      });

      document.addEventListener('mousemove', (e) => {
        if (!dragState) return;

        const listRect = itemsList.getBoundingClientRect();
        const rowH = dragState.row.getBoundingClientRect().height;
        const minY = listRect.top;
        const maxY = listRect.bottom - rowH;
        const clampedY = Math.max(minY, Math.min(maxY, e.clientY - dragState.offsetY));
        dragState.clone.style.left = dragState.row.getBoundingClientRect().left + 'px';
        dragState.clone.style.top = clampedY + 'px';

        const rows = [...itemsList.querySelectorAll('.item-row')];
        let target = null;
        let minDist = Infinity;
        rows.forEach((r) => {
          if (r === dragState.row) return;
          const mid = r.getBoundingClientRect().top + r.getBoundingClientRect().height / 2;
          const d = Math.abs(e.clientY - mid);
          if (d < minDist) { minDist = d; target = r; }
        });

        if (!target) return;

        const rect = target.getBoundingClientRect();
        const mid = rect.top + rect.height / 2;

        const play = flipAnimate(itemsList, dragState.row);
        if (e.clientY < mid) {
          itemsList.insertBefore(dragState.row, target);
        } else {
          itemsList.insertBefore(dragState.row, target.nextSibling);
        }
        play();
      });

      document.addEventListener('mouseup', async (e) => {
        if (!dragState) return;
        const state = dragState;
        dragState = null;

        const finalRect = state.row.getBoundingClientRect();
        state.clone.style.transition = 'left 150ms ease-out, top 150ms ease-out, opacity 150ms ease-out';
        state.clone.style.left = finalRect.left + 'px';
        state.clone.style.top = finalRect.top + 'px';
        state.clone.style.opacity = '0';
        state.clone.addEventListener('transitionend', () => {
          if (state.clone.parentNode) state.clone.remove();
        }, { once: true });

        state.row.classList.remove('dragging');
        itemsList.querySelectorAll('.item-row').forEach((r) => {
          r.style.transition = '';
          r.style.transform = '';
        });

        const rows = itemsList.querySelectorAll('.item-row');
        const newOrder = Array.from(rows).map((r) => r.dataset.itemId);
        const playlists = await dopGetPlaylists();
        const pl = playlists.find((p) => p.id === state.playlistId);
        if (pl) {
          const ordered = newOrder.map((id) => pl.items.find((i) => i.id === id)).filter(Boolean);
          if (ordered.length === pl.items.length) {
            pl.items = ordered;
            await dopSavePlaylists(playlists);
          }
        }
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

  function showConfirm(message) {
    return new Promise((resolve) => {
      let modal = document.getElementById('d-op-confirm-modal');
      if (modal) modal.remove();

      function dismiss(result) {
        modal.classList.add('modal-out');
        const panel = modal.querySelector('.d-op-modal-panel');
        if (panel) panel.style.animation = 'panel-out 100ms ease-in forwards';
        modal.addEventListener('animationend', () => {
          modal.remove();
          resolve(result);
        }, { once: true });
      }

      modal = document.createElement('div');
      modal.id = 'd-op-confirm-modal';
      modal.className = 'd-op-modal';

      const panel = document.createElement('div');
      panel.className = 'd-op-modal-panel';
      panel.style.minWidth = '260px';

      const msg = document.createElement('p');
      msg.textContent = message;
      panel.appendChild(msg);

      const footer = document.createElement('div');
      footer.className = 'd-op-modal-footer';
      const cancelBtn = document.createElement('button');
      cancelBtn.textContent = 'キャンセル';
      cancelBtn.className = 'btn-text';
      cancelBtn.addEventListener('click', () => dismiss(false));

      const confirmBtn = document.createElement('button');
      confirmBtn.textContent = '削除';
      confirmBtn.style.background = 'var(--dop-danger)';
      confirmBtn.style.color = '#fff';
      confirmBtn.style.border = 'none';
      confirmBtn.style.padding = 'var(--dop-space-4) var(--dop-space-6)';
      confirmBtn.style.borderRadius = 'var(--dop-radius-sm)';
      confirmBtn.style.cursor = 'pointer';
      confirmBtn.addEventListener('click', () => dismiss(true));

      footer.appendChild(cancelBtn);
      footer.appendChild(confirmBtn);
      panel.appendChild(footer);
      modal.appendChild(panel);

      modal.addEventListener('click', (e) => { if (e.target === modal) dismiss(false); });
      document.addEventListener('keydown', function onKey(e) {
        if (e.key === 'Escape') { dismiss(false); document.removeEventListener('keydown', onKey); }
      });
      document.body.appendChild(modal);
      confirmBtn.focus();
    });
  }

  function showImportChoice() {
    return new Promise((resolve) => {
      let modal = document.getElementById('d-op-import-modal');
      if (modal) modal.remove();

      modal = document.createElement('div');
      modal.className = 'd-op-modal';

      const panel = document.createElement('div');
      panel.className = 'd-op-modal-panel';

      const h3 = document.createElement('h3');
      h3.textContent = 'インポート方法';
      panel.appendChild(h3);

      const msg = document.createElement('p');
      msg.textContent = 'すでにプレイリストが存在します。インポートしたデータをマージしますか？それとも既存データをすべて上書きしますか？';
      panel.appendChild(msg);

      const footer = document.createElement('div');
      footer.className = 'd-op-modal-footer';

      const cancelBtn = document.createElement('button');
      cancelBtn.textContent = 'キャンセル';
      cancelBtn.className = 'btn-text';
      cancelBtn.addEventListener('click', () => { modal.remove(); resolve(null); });

      const replaceBtn = document.createElement('button');
      replaceBtn.textContent = '上書き';
      replaceBtn.style.background = 'var(--dop-danger)';
      replaceBtn.style.color = '#fff';
      replaceBtn.style.border = 'none';
      replaceBtn.style.padding = 'var(--dop-space-4) var(--dop-space-6)';
      replaceBtn.style.borderRadius = 'var(--dop-radius-sm)';
      replaceBtn.style.cursor = 'pointer';
      replaceBtn.addEventListener('click', () => { modal.remove(); resolve('replace'); });

      const mergeBtn = document.createElement('button');
      mergeBtn.textContent = 'マージ';
      mergeBtn.style.background = 'var(--dop-accent)';
      mergeBtn.style.color = '#fff';
      mergeBtn.style.border = 'none';
      mergeBtn.style.padding = 'var(--dop-space-4) var(--dop-space-6)';
      mergeBtn.style.borderRadius = 'var(--dop-radius-sm)';
      mergeBtn.style.cursor = 'pointer';
      mergeBtn.style.fontWeight = '600';
      mergeBtn.addEventListener('click', () => { modal.remove(); resolve('merge'); });

      footer.appendChild(cancelBtn);
      footer.appendChild(replaceBtn);
      footer.appendChild(mergeBtn);
      panel.appendChild(footer);
      modal.appendChild(panel);

      modal.addEventListener('click', (e) => { if (e.target === modal) { modal.remove(); resolve(null); } });
      document.addEventListener('keydown', function onKey(e) {
        if (e.key === 'Escape') { modal.remove(); resolve(null); document.removeEventListener('keydown', onKey); }
      });
      document.body.appendChild(modal);
      mergeBtn.focus();
    });
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

      const targets = playlists.filter((p) => !isSystemPlaylist(p));
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
      document.addEventListener('keydown', function onKey(e) {
        if (e.key === 'Escape') {
          modal.remove();
          resolve(null);
          document.removeEventListener('keydown', onKey);
        }
      });
      document.body.appendChild(modal);
      cancelBtn.focus();
    });
  }

  function findNameConflicts(existing, imported) {
    const existingNames = new Set(existing.map((p) => p.name));
    return imported.filter((p) => existingNames.has(p.name));
  }

  function mergePlaylists(existing, imported, mergeNames) {
    const mergeNameSet = new Set(mergeNames);
    const result = [...existing];
    let skipped = 0;

    imported.forEach((imp) => {
      const sameName = result.find((m) => m.name === imp.name);
      if (sameName && mergeNameSet.has(imp.name)) {
        const existingKeys = new Set();
        sameName.items.forEach((item) => {
          existingKeys.add(item.id);
          if (item.partId && item.range) {
            existingKeys.add(`${item.partId}|${item.range.start}|${item.range.end}`);
          }
        });
        imp.items.forEach((item) => {
          if (existingKeys.has(item.id)) {
            skipped++;
            return;
          }
          const contentKey = item.partId && item.range
            ? `${item.partId}|${item.range.start}|${item.range.end}`
            : null;
          if (contentKey && existingKeys.has(contentKey)) {
            skipped++;
            return;
          }
          sameName.items.push(item);
          if (item.id) existingKeys.add(item.id);
          if (contentKey) existingKeys.add(contentKey);
        });
      } else {
        result.push({ ...imp });
      }
    });

    return { playlists: result, skipped };
  }

  function dedupeNames(imported, existing) {
    const existingNames = new Set(existing.map((p) => p.name));
    return imported.map((p) => {
      if (!existingNames.has(p.name)) return p;
      let n = 2;
      let candidate;
      do { candidate = `${p.name} (${n++})`; } while (existingNames.has(candidate));
      existingNames.add(candidate);
      return { ...p, name: candidate, id: dopGenerateId() };
    });
  }

  function showMergeNameChoice(conflicts) {
    return new Promise((resolve) => {
      let modal = document.getElementById('d-op-mergename-modal');
      if (modal) modal.remove();

      modal = document.createElement('div');
      modal.id = 'd-op-mergename-modal';
      modal.className = 'd-op-modal';

      const panel = document.createElement('div');
      panel.className = 'd-op-modal-panel';

      const h3 = document.createElement('h3');
      h3.textContent = '同名のプレイリスト';
      panel.appendChild(h3);

      const msg = document.createElement('p');
      const names = conflicts.map((c) => `「${c.name}」（${c.items.length}件）`).join('、');
      msg.textContent = `既存の${names}と統合しますか？`;
      panel.appendChild(msg);

      const footer = document.createElement('div');
      footer.className = 'd-op-modal-footer';

      const cancelBtn = document.createElement('button');
      cancelBtn.textContent = 'キャンセル';
      cancelBtn.className = 'btn-text';
      cancelBtn.addEventListener('click', () => { modal.remove(); resolve(null); });

      const separateBtn = document.createElement('button');
      separateBtn.textContent = '別名で追加';
      separateBtn.className = 'btn-text';
      separateBtn.addEventListener('click', () => { modal.remove(); resolve('separate'); });

      const mergeBtn = document.createElement('button');
      mergeBtn.textContent = 'マージ（重複スキップ）';
      mergeBtn.style.background = 'var(--dop-accent)';
      mergeBtn.style.color = '#fff';
      mergeBtn.style.border = 'none';
      mergeBtn.style.padding = 'var(--dop-space-4) var(--dop-space-6)';
      mergeBtn.style.borderRadius = 'var(--dop-radius-sm)';
      mergeBtn.style.cursor = 'pointer';
      mergeBtn.style.fontWeight = '600';
      mergeBtn.addEventListener('click', () => { modal.remove(); resolve('merge'); });

      footer.appendChild(cancelBtn);
      footer.appendChild(separateBtn);
      footer.appendChild(mergeBtn);
      panel.appendChild(footer);
      modal.appendChild(panel);

      modal.addEventListener('click', (e) => { if (e.target === modal) { modal.remove(); resolve(null); } });
      document.addEventListener('keydown', function onKey(e) {
        if (e.key === 'Escape') { modal.remove(); resolve(null); document.removeEventListener('keydown', onKey); }
      });
      document.body.appendChild(modal);
      mergeBtn.focus();
    });
  }

  async function startPlaylistPlayback(playlistId, index = 0) {
    const playlists = await dopGetPlaylists();
    const playlist = playlists.find((p) => p.id === playlistId);
    if (!playlist || playlist.items.length === 0) {
      showPlaybackError('プレイリストが空です。');
      return;
    }
    const item = playlist.items[index];
    if (!item || !item.range) {
      showPlaybackError('選択したアイテムに範囲が設定されていません。');
      return;
    }
    await dopSetPlayback({ playlistId, index, updatedAt: Date.now() });
    await dopClearPending();
    const url = new URL(item.url);
    url.searchParams.set('dopPlaylistId', playlistId);
    url.searchParams.set('dopIndex', String(index));
    browser.runtime.sendMessage({ type: 'REQUEST_PLAYER', url: url.toString() });
  }

  function showPlaybackError(message) {
    let modal = document.getElementById('d-op-playback-error-modal');
    if (modal) modal.remove();

    modal = document.createElement('div');
    modal.id = 'd-op-playback-error-modal';
    modal.className = 'd-op-modal';

    const panel = document.createElement('div');
    panel.className = 'd-op-modal-panel';
    panel.style.minWidth = '280px';

    const msg = document.createElement('p');
    msg.textContent = message;
    msg.style.marginBottom = '0';
    panel.appendChild(msg);

    const footer = document.createElement('div');
    footer.className = 'd-op-modal-footer';
    const okBtn = document.createElement('button');
    okBtn.textContent = 'OK';
    okBtn.style.background = 'var(--dop-accent)';
    okBtn.style.color = '#fff';
    okBtn.style.border = 'none';
    okBtn.style.padding = 'var(--dop-space-4) var(--dop-space-6)';
    okBtn.style.borderRadius = 'var(--dop-radius-sm)';
    okBtn.style.cursor = 'pointer';
    okBtn.style.fontWeight = '600';
    okBtn.addEventListener('click', () => modal.remove());
    footer.appendChild(okBtn);
    panel.appendChild(footer);
    modal.appendChild(panel);

    function dismiss() {
      modal.remove();
      document.removeEventListener('keydown', onKey);
    }
    modal.addEventListener('click', (e) => { if (e.target === modal) dismiss(); });
    function onKey(e) {
      if (e.key === 'Escape') dismiss();
      if (e.key === 'Enter') dismiss();
    }
    document.addEventListener('keydown', onKey);
    document.body.appendChild(modal);
    okBtn.focus();
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

  newNameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      createBtn.click();
    }
  });

  exportBtn.className = 'btn-secondary';
  exportBtn.addEventListener('click', async () => {
    const playlists = (await dopGetPlaylists()).filter((p) => !isSystemPlaylist(p));
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
      const cleaned = data
        .filter((p) => !isSystemPlaylist(p))
        .map((p) => ({
          id: p.id || dopGenerateId(),
          name: p.name || 'imported',
          items: Array.isArray(p.items) ? p.items.map((i) => ({
            id: i.id || dopGenerateId(),
            partId: i.partId || '',
            workId: i.workId || '',
            title: i.title || '',
            episodeTitle: i.episodeTitle || '',
            url: i.url || '',
            range: i.range ? { ...i.range } : null
          })) : []
        }));

      const existing = (await dopGetPlaylists()).filter((p) => !isSystemPlaylist(p));
      if (existing.length > 0) {
        const choice = await showImportChoice();
        if (choice === 'replace') {
          await dopSavePlaylists(cleaned);
          renderPlaylists();
          showStatus('インポートしました（上書き）。');
        } else if (choice === 'merge') {
          const conflicts = findNameConflicts(existing, cleaned);
          let mergeMode = 'merge';
          if (conflicts.length > 0) {
            mergeMode = await showMergeNameChoice(conflicts);
            if (!mergeMode) { renderPlaylists(); e.target.value = ''; return; }
          }
          let toImport = cleaned;
          if (mergeMode === 'separate') {
            toImport = dedupeNames(cleaned, existing);
          }
          const mergeNames = mergeMode === 'merge' ? conflicts.map((c) => c.name) : [];
          const { playlists: merged, skipped } = mergePlaylists(existing, toImport, mergeNames);
          await dopSavePlaylists(merged);
          renderPlaylists();
          const imported = cleaned.reduce((s, p) => s + p.items.length, 0);
          const added = imported - skipped;
          showStatus(`インポート: ${added}件追加${skipped > 0 ? `（${skipped}件の重複をスキップ）` : ''}`);
        } else {
          e.target.value = '';
          return;
        }
      } else {
        await dopSavePlaylists(cleaned);
        renderPlaylists();
        const total = cleaned.reduce((s, p) => s + p.items.length, 0);
        showStatus(`インポート: ${total}件追加`);
      }
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

  document.getElementById('optionsVersion').textContent = 'd-OP v' + browser.runtime.getManifest().version;

  renderPlaylists();
  initWindowModeSetting();
})();
