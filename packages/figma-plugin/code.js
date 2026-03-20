figma.showUI(__html__, { width: 340, height: 280, title: 'Agent Bridge', themeColors: true });

figma.ui.postMessage({ type: 'file-name', fileName: figma.root.name });

function summarizeChildren(node) {
  return node.children ? node.children.map(function(child) {
    return { id: child.id, name: child.name, type: child.type };
  }) : [];
}

async function exportNodeDocument(node) {
  if (node.type === 'DOCUMENT' || node.type === 'PAGE') {
    return {
      id: node.id,
      name: node.name,
      type: node.type,
      children: summarizeChildren(node),
    };
  }
  var exported = await node.exportAsync({ format: 'JSON_REST_V1' });
  if (typeof exported === 'object' && exported !== null && exported.document) {
    return exported.document;
  }
  throw new Error('exportAsync returned unexpected type: ' + typeof exported);
}

function bytesToBase64(bytes) {
  var CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  var b64 = '';
  var i = 0;
  while (i < bytes.length) {
    var b0 = bytes[i++];
    var b1 = i < bytes.length ? bytes[i++] : 0;
    var b2 = i < bytes.length ? bytes[i++] : 0;
    b64 += CHARS[b0 >> 2];
    b64 += CHARS[((b0 & 3) << 4) | (b1 >> 4)];
    b64 += CHARS[((b1 & 15) << 2) | (b2 >> 6)];
    b64 += CHARS[b2 & 63];
  }
  var pad = bytes.length % 3;
  if (pad === 1) {
    b64 = b64.slice(0, -2) + '==';
  } else if (pad === 2) {
    b64 = b64.slice(0, -1) + '=';
  }
  return b64;
}

function bytesToString(bytes) {
  var result = '';
  var chunkSize = 8192;
  for (var i = 0; i < bytes.length; i += chunkSize) {
    var end = i + chunkSize < bytes.length ? i + chunkSize : bytes.length;
    var slice = bytes.slice(i, end);
    result += String.fromCharCode.apply(null, slice);
  }
  return result;
}

async function handleCommand(command, params) {
  switch (command) {
    case 'get_document_info':
      return {
        name: figma.root.name,
        currentPage: {
          id: figma.currentPage.id,
          name: figma.currentPage.name,
        },
      };

    case 'get_selection':
      return figma.currentPage.selection.map(function(node) {
        return { id: node.id, name: node.name, type: node.type };
      });

    case 'get_node': {
      var node = await figma.getNodeByIdAsync(params.nodeId);
      if (!node) {
        return { error: 'Node not found: ' + params.nodeId };
      }
      return exportNodeDocument(node);
    }

    case 'get_nodes': {
      var nodeIds = params.nodeIds || [];
      return Promise.all(nodeIds.map(async function(nodeId) {
        var node = await figma.getNodeByIdAsync(nodeId);
        if (!node) {
          return { id: nodeId, error: 'Node not found' };
        }
        return exportNodeDocument(node);
      }));
    }

    case 'get_page_layout': {
      return {
        pageName: figma.currentPage.name,
        frames: figma.currentPage.children.map(function(frame) {
          return {
            id: frame.id,
            name: frame.name,
            type: frame.type,
            x: frame.x,
            y: frame.y,
            width: frame.width,
            height: frame.height,
            childCount: frame.children ? frame.children.length : 0,
          };
        }),
      };
    }

    case 'get_pages':
      return figma.root.children.map(function(page) {
        return {
          id: page.id,
          name: page.name,
          isCurrent: page.id === figma.currentPage.id,
          childCount: page.children ? page.children.length : 0,
        };
      });

    case 'export_node': {
      var exportNode = await figma.getNodeByIdAsync(params.nodeId);
      if (!exportNode) {
        return { error: 'Node not found: ' + params.nodeId };
      }
      var exportFormat = params.format || 'PNG';
      var exportScale = params.scale || 1;
      var bytes = await exportNode.exportAsync({ format: exportFormat, constraint: { type: 'SCALE', value: exportScale } });
      var data = exportFormat === 'SVG' ? bytesToString(bytes) : bytesToBase64(bytes);
      return { format: exportFormat, scale: exportScale, data: data };
    }

    case 'get_styles': {
      var paintStyles = figma.getLocalPaintStyles().map(function(s) {
        return {
          id: s.id,
          name: s.name,
          paints: s.paints.map(function(p) {
            return { type: p.type, color: p.color, opacity: p.opacity };
          }),
        };
      });
      var textStyles = figma.getLocalTextStyles().map(function(s) {
        return {
          id: s.id,
          name: s.name,
          fontFamily: s.fontName.family,
          fontStyle: s.fontName.style,
          fontSize: s.fontSize,
          lineHeight: s.lineHeight.unit === 'PIXELS' ? s.lineHeight.value : null,
        };
      });
      var effectStyles = figma.getLocalEffectStyles().map(function(s) {
        return {
          id: s.id,
          name: s.name,
          effects: s.effects.map(function(e) {
            return { type: e.type, color: e.color, offset: e.offset, radius: e.radius, spread: e.spread };
          }),
        };
      });
      var gridStyles = figma.getLocalGridStyles().map(function(s) {
        return { id: s.id, name: s.name };
      });
      return { paint: paintStyles, text: textStyles, effect: effectStyles, grid: gridStyles };
    }

    case 'get_local_components': {
      var componentSets = figma.root.findAllWithCriteria({ types: ['COMPONENT_SET'] });
      var components = figma.root.findAllWithCriteria({ types: ['COMPONENT'] });

      var setMap = {};
      for (var csi = 0; csi < componentSets.length; csi++) {
        var cs = componentSets[csi];
        var variantKeys = {};
        if (cs.children) {
          for (var vi = 0; vi < cs.children.length; vi++) {
            var variant = cs.children[vi];
            var props = variant.variantProperties;
            if (props) {
              var propKeys = Object.keys(props);
              for (var pk = 0; pk < propKeys.length; pk++) {
                var pkey = propKeys[pk];
                if (!variantKeys[pkey]) { variantKeys[pkey] = []; }
                if (variantKeys[pkey].indexOf(props[pkey]) === -1) {
                  variantKeys[pkey].push(props[pkey]);
                }
              }
            }
          }
        }
        var csDefs = cs.componentPropertyDefinitions || {};
        var csDefKeys = Object.keys(csDefs);
        var csProps = [];
        for (var di = 0; di < csDefKeys.length; di++) {
          var def = csDefs[csDefKeys[di]];
          csProps.push({ name: csDefKeys[di], type: def.type, default: def.defaultValue });
        }
        setMap[cs.id] = {
          id: cs.id,
          name: cs.name,
          page: cs.parent && cs.parent.type === 'PAGE' ? cs.parent.name : null,
          variants: Object.keys(variantKeys).length > 0 ? variantKeys : null,
          properties: csProps,
        };
      }

      var standaloneComponents = [];
      for (var si = 0; si < components.length; si++) {
        var comp = components[si];
        if (comp.parent && comp.parent.type === 'COMPONENT_SET') {
          continue;
        }
        var compDefs = comp.componentPropertyDefinitions || {};
        var compDefKeys = Object.keys(compDefs);
        var compProps = [];
        for (var cdi = 0; cdi < compDefKeys.length; cdi++) {
          var cdef = compDefs[compDefKeys[cdi]];
          compProps.push({ name: compDefKeys[cdi], type: cdef.type, default: cdef.defaultValue });
        }
        standaloneComponents.push({
          id: comp.id,
          name: comp.name,
          page: comp.parent && comp.parent.type === 'PAGE' ? comp.parent.name : null,
          variants: null,
          properties: compProps,
        });
      }

      var instances = figma.root.findAllWithCriteria({ types: ['INSTANCE'] });
      var remoteMap = {};
      for (var ii = 0; ii < instances.length; ii++) {
        var inst = instances[ii];
        var main = inst.mainComponent;
        if (main && main.remote) {
          var mkey = main.key;
          if (!remoteMap[mkey]) {
            remoteMap[mkey] = {
              key: mkey,
              name: main.name,
              library: main.parent && main.parent.name ? main.parent.name : 'Unknown',
              instancesCount: 0,
            };
          }
          remoteMap[mkey].instancesCount++;
        }
      }

      var localAll = Object.keys(setMap).map(function(k) { return setMap[k]; });
      localAll = localAll.concat(standaloneComponents);
      var remoteAll = Object.keys(remoteMap).map(function(k) { return remoteMap[k]; });

      return { local: localAll, remote: remoteAll };
    }

    case 'search_nodes': {
      var searchName = params.name || '';
      var searchType = params.type || null;
      var searchPageId = params.pageId || null;
      var searchLimit = params.limit || 50;

      var searchPages = [];
      if (searchPageId) {
        var pageNode = await figma.getNodeByIdAsync(searchPageId);
        if (pageNode && pageNode.type === 'PAGE') {
          searchPages.push(pageNode);
        }
      } else {
        for (var spi = 0; spi < figma.root.children.length; spi++) {
          searchPages.push(figma.root.children[spi]);
        }
      }

      var globPattern = searchName.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
      var nameRegex = searchName ? new RegExp(globPattern, 'i') : null;

      var matches = [];
      for (var pi = 0; pi < searchPages.length; pi++) {
        var sp = searchPages[pi];
        var found = sp.findAll(function(node) {
          if (nameRegex && !nameRegex.test(node.name)) { return false; }
          if (searchType && node.type !== searchType) { return false; }
          return true;
        });
        for (var fi = 0; fi < found.length && matches.length < searchLimit; fi++) {
          var fn = found[fi];
          matches.push({
            id: fn.id,
            name: fn.name,
            type: fn.type,
            page: sp.name,
            parent: fn.parent ? fn.parent.name + ' [' + fn.parent.id + ']' : null,
            width: fn.width !== undefined ? fn.width : null,
            height: fn.height !== undefined ? fn.height : null,
          });
        }
        if (matches.length >= searchLimit) { break; }
      }

      var truncated = matches.length >= searchLimit;
      return { results: matches.slice(0, searchLimit), truncated: truncated };
    }

    default:
      return { error: 'Unknown command: ' + command };
  }
}

figma.ui.onmessage = async function (msg) {
  if (msg.type === 'execute-command') {
    var result;
    try {
      result = await handleCommand(msg.command, msg.params);
    } catch (err) {
      result = { error: String(err) };
    }

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
