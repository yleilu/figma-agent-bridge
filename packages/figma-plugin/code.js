figma.showUI(__html__, { width: 340, height: 280, title: 'Agent Bridge', themeColors: true });

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

figma.ui.onmessage = function (msg) {
  if (msg.type === 'execute-command') {
    var result = handleCommand(msg.command, msg.params);

    figma.ui.postMessage({
      type: 'command-result',
      id: msg.id,
      result: result,
    });
  }
};
