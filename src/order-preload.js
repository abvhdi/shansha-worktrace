const { contextBridge, ipcRenderer } = require('electron');

function injectPicker() {
  document.addEventListener('click', async (event) => {
    const input = event.target && event.target.closest ? event.target.closest('input[type=file]') : null;
    if (!input) return;
    event.preventDefault();
    event.stopPropagation();
    try {
      const picked = await ipcRenderer.invoke('order:pickFile', { accept: input.getAttribute('accept') || '' });
      if (!picked || !picked.ok) return;
      const binary = atob(picked.base64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
      const file = new File([bytes], picked.name, { type: picked.mime || 'application/octet-stream' });
      const transfer = new DataTransfer();
      transfer.items.add(file);
      input.files = transfer.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    } catch (error) { console.error('选择文件失败', error); }
  }, true);
}

window.addEventListener('DOMContentLoaded', () => { injectPicker(); });

contextBridge.exposeInMainWorld('orderBridge', {
  pickFile: (accept) => ipcRenderer.invoke('order:pickFile', { accept: accept || '' }),
});
