figma.showUI(__html__, { width: 340, height: 280, title: 'Agent Bridge', themeColors: true });

figma.ui.postMessage({ type: 'file-name', fileName: figma.root.name });

function handleCommand(command, params) {
  if (command === 'get_document_info') {
    return {
      name: figma.root.name,
      currentPage: {
        id: figma.currentPage.id,
        name: figma.currentPage.name,
      },
    };
  }

  return { error: 'Unknown command: ' + command };
}

figma.ui.onmessage = async function (msg) {
  if (msg.type === 'execute-command') {
    var result = handleCommand(msg.command, msg.params);

    figma.ui.postMessage({
      type: 'command-result',
      id: msg.id,
      result: result,
    });
  }

  if (msg.type === 'storage-get') {
    var value = await figma.clientStorage.getAsync(msg.key);
    figma.ui.postMessage({
      type: 'storage-result',
      key: msg.key,
      value: value !== undefined ? value : null,
    });
  }

  if (msg.type === 'storage-set') {
    await figma.clientStorage.setAsync(msg.key, msg.value);
  }

  if (msg.type === 'storage-delete') {
    await figma.clientStorage.deleteAsync(msg.key);
  }
};
