figma.showUI(__html__, { width: 340, height: 280, title: 'Agent Bridge', themeColors: true });

figma.ui.postMessage({ type: 'file-name', fileName: figma.root.name });

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
      var nodeId = params.nodeId;
      var node = await figma.getNodeByIdAsync(nodeId);
      if (!node) {
        return { error: 'Node not found: ' + nodeId };
      }
      if (node.type === 'DOCUMENT' || node.type === 'PAGE') {
        return {
          id: node.id,
          name: node.name,
          type: node.type,
          children: node.children ? node.children.map(function(child) {
            return { id: child.id, name: child.name, type: child.type };
          }) : [],
        };
      }
      var bytes = await node.exportAsync({ format: 'JSON_REST_V1' });
      var jsonStr = '';
      for (var bi = 0; bi < bytes.length; bi++) {
        jsonStr += String.fromCharCode(bytes[bi]);
      }
      var parsed = JSON.parse(jsonStr);
      return parsed.document;
    }

    case 'get_nodes': {
      var nodeIds = params.nodeIds || [];
      var results = await Promise.all(nodeIds.map(async function(nodeId) {
        var node = await figma.getNodeByIdAsync(nodeId);
        if (!node) {
          return { id: nodeId, error: 'Node not found' };
        }
        if (node.type === 'DOCUMENT' || node.type === 'PAGE') {
          return {
            id: node.id,
            name: node.name,
            type: node.type,
            children: node.children ? node.children.map(function(child) {
              return { id: child.id, name: child.name, type: child.type };
            }) : [],
          };
        }
        var bytes = await node.exportAsync({ format: 'JSON_REST_V1' });
        var jsonStr = '';
        for (var bi = 0; bi < bytes.length; bi++) {
          jsonStr += String.fromCharCode(bytes[bi]);
        }
        var parsed = JSON.parse(jsonStr);
        return parsed.document;
      }));
      return results;
    }

    case 'get_page_layout': {
      var frames = [];
      var children = figma.currentPage.children;
      for (var i = 0; i < children.length; i++) {
        var frame = children[i];
        frames.push({
          id: frame.id,
          name: frame.name,
          type: frame.type,
          x: frame.x,
          y: frame.y,
          width: frame.width,
          height: frame.height,
          childCount: frame.children ? frame.children.length : 0,
        });
      }
      return {
        pageName: figma.currentPage.name,
        frames: frames,
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
      var exportNodeId = params.nodeId;
      var exportFormat = params.format || 'PNG';
      var exportScale = params.scale || 1;
      var exportNode = await figma.getNodeByIdAsync(exportNodeId);
      if (!exportNode) {
        return { error: 'Node not found: ' + exportNodeId };
      }
      var bytes = await exportNode.exportAsync({ format: exportFormat, constraint: { type: 'SCALE', value: exportScale } });
      var data;
      if (exportFormat === 'SVG') {
        var chars = [];
        for (var si = 0; si < bytes.length; si++) {
          chars.push(String.fromCharCode(bytes[si]));
        }
        data = chars.join('');
      } else {
        var CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
        var b64 = '';
        var bi = 0;
        while (bi < bytes.length) {
          var b0 = bytes[bi++];
          var b1 = bi < bytes.length ? bytes[bi++] : 0;
          var b2 = bi < bytes.length ? bytes[bi++] : 0;
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
        data = b64;
      }
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

      // Build component set entries with variant info
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

      // Standalone components (not inside a component set)
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

      // Remote components discovered via instances
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

      var localAll = [];
      var setKeys = Object.keys(setMap);
      for (var ski = 0; ski < setKeys.length; ski++) {
        localAll.push(setMap[setKeys[ski]]);
      }
      for (var sai = 0; sai < standaloneComponents.length; sai++) {
        localAll.push(standaloneComponents[sai]);
      }

      var remoteAll = [];
      var remoteKeys = Object.keys(remoteMap);
      for (var rki = 0; rki < remoteKeys.length; rki++) {
        remoteAll.push(remoteMap[remoteKeys[rki]]);
      }

      return { local: localAll, remote: remoteAll };
    }

    case 'search_nodes': {
      var searchName = params.name || '';
      var searchType = params.type || null;
      var searchPageId = params.pageId || null;
      var searchLimit = params.limit || 50;

      // Determine which pages to search
      var searchPages = [];
      if (searchPageId) {
        var pageNode = await figma.getNodeByIdAsync(searchPageId);
        if (pageNode && pageNode.type === 'PAGE') {
          searchPages.push(pageNode);
        }
      } else {
        // Search all pages
        for (var spi = 0; spi < figma.root.children.length; spi++) {
          searchPages.push(figma.root.children[spi]);
        }
      }

      var globPattern = searchName.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
      var nameRegex = searchName ? new RegExp(globPattern, 'i') : null;

      var matches = [];
      var stopped = false;
      for (var spi2 = 0; spi2 < searchPages.length; spi2++) {
        if (stopped) { break; }
        var sp = searchPages[spi2];
        var found = sp.findAll(function(node) {
          if (nameRegex && !nameRegex.test(node.name)) { return false; }
          if (searchType && node.type !== searchType) { return false; }
          return true;
        });
        for (var fi = 0; fi < found.length; fi++) {
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
          if (matches.length > searchLimit) {
            stopped = true;
            break;
          }
        }
      }

      var truncated = matches.length > searchLimit;
      if (truncated) {
        matches = matches.slice(0, searchLimit);
      }
      return { results: matches, truncated: truncated };
    }

    default:
      return { error: 'Unknown command: ' + command };
  }
}

figma.ui.onmessage = async function (msg) {
  if (msg.type === 'execute-command') {
    var result = await handleCommand(msg.command, msg.params);

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
