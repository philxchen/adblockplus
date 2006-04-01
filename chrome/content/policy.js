/* ***** BEGIN LICENSE BLOCK *****
 * Version: MPL 1.1
 *
 * The contents of this file are subject to the Mozilla Public License Version
 * 1.1 (the "License"); you may not use this file except in compliance with
 * the License. You may obtain a copy of the License at
 * http://www.mozilla.org/MPL/
 *
 * Software distributed under the License is distributed on an "AS IS" basis,
 * WITHOUT WARRANTY OF ANY KIND, either express or implied. See the License
 * for the specific language governing rights and limitations under the
 * License.
 *
 * The Original Code is Adblock Plus.
 *
 * The Initial Developer of the Original Code is
 * Wladimir Palant.
 * Portions created by the Initial Developer are Copyright (C) 2006
 * the Initial Developer. All Rights Reserved.
 *
 * Contributor(s):
 *
 * ***** END LICENSE BLOCK ***** */

/*
 * Content policy implementation, responsible for blocking things.
 * This file is included from nsAdblockPlus.js.
 */

var type, typeDescr, localizedDescr, blockTypes, whitelistSchemes, linkTypes, nonCollapsableTypes;

const ok = ("ACCEPT" in Components.interfaces.nsIContentPolicy ? Components.interfaces.nsIContentPolicy.ACCEPT : true);
const block = ("REJECT_REQUEST" in Components.interfaces.nsIContentPolicy ? Components.interfaces.nsIContentPolicy.REJECT_REQUEST : false);
const oldStyleAPI = (typeof ok == "boolean");

var policy = {
  init: function() {
    var types = ["OTHER", "SCRIPT", "IMAGE", "STYLESHEET", "OBJECT", "SUBDOCUMENT", "DOCUMENT"];

    // type constant by type description and type description by type constant
    type = {};
    typeDescr = {};
    localizedDescr = {};
    var iface = Components.interfaces.nsIContentPolicy;
    for (var k = 0; k < types.length; k++) {
      var typeName = types[k];
      type[typeName] = typeName in iface ? iface[typeName] : iface["TYPE_" + typeName];
      typeDescr[type[typeName]] = typeName;
      localizedDescr[type[typeName]] = abp.getString("type_label_" + typeName.toLowerCase());
    }
  
    type.LINK = 0xFFFF;
    typeDescr[0xFFFF] = "LINK";
    localizedDescr[0xFFFF] = abp.getString("type_label_link");
  
    type.BACKGROUND = 0xFFFE;
    typeDescr[0xFFFE] = "BACKGROUND";
    localizedDescr[0xFFFE] = abp.getString("type_label_background");
  
    // blockable content policy types
    blockTypes = this.translateTypeList(prefs.blocktypes);

    // whitelisted URL schemes
    whitelistSchemes = this.translateList(prefs.whitelistschemes);

    // whitelisted URL schemes
    localSchemes = this.translateList(prefs.localschemes);

    // types that should be searched for links
    linkTypes = this.translateTypeList(prefs.linktypes);

    // types that shouldn't be collapsed
    nonCollapsableTypes = this.translateTypeList(prefs.noncollapsabletypes);
  },

  // Checks whether a node should be blocked, hides it if necessary, return value false means that the node is blocked
  processNode: function(insecNode, contentType, location, collapse) {
    var insecWnd = getWindow(insecNode);
    if (!insecWnd)
      return true;

    var insecTop = secureGet(insecWnd, "top");
    if (!insecTop)
      return true;

    var topLocation = unwrapURL(secureGet(insecTop, "location", "href"));
    var blockable = this.isBlockableScheme(topLocation);
    if (!blockable && prefs.blocklocalpages && this.isLocalScheme(topLocation))
      blockable = true;
    if (!blockable)
      return true;

    var pageMatch = this.isWhitelisted(topLocation);
    if (pageMatch) {
      prefs.increaseHitCount(pageMatch);
      return true;
    }

    var data = DataContainer.getDataForWindow(insecWnd);

    var match = null;
    var linksOk = true;
    if (prefs.enabled) {
      // Try to use previous results - if there were any
      match = cache.get(location);

      if (typeof match == "undefined") {
        // If we didn't cache the result yet:
        // check whether we want to block the node and store the result
        match = prefs.whitePatterns.matchesAny(location);

        if (match == null)
          match = prefs.filterPatterns.matchesAny(location);

        cache.put(location, match);
      }

      if (match)
        prefs.increaseHitCount(match);

      if (!(insecNode instanceof Window)) {
        // Check links in parent nodes
        if (insecNode && prefs.linkcheck && this.shouldCheckLinks(contentType))
          linksOk = this.checkLinks(insecNode);
  
        // Show object tabs unless this is a standalone object
        // XXX: We will never recognize objects loading from jar: as standalone!
        if (!match && prefs.frameobjects &&
            contentType == type.OBJECT && location != secureGet(insecWnd, "location", "href"))
          secureLookup(insecWnd, "setTimeout")(addObjectTab, 0, insecNode, location, insecTop);
      }
    }

    // Fix type for background images
    if (contentType == type.IMAGE && (insecNode instanceof Window || secureGet(insecNode, "nodeType") == Node.DOCUMENT_NODE)) {
      contentType = type.BACKGROUND;
      if (insecNode instanceof Window)
        insecNode = secureGet(insecNode, "document");
    }

    // Store node data (must set storedLoc parameter so that frames are added immediately when refiltering)
    data.addNode(insecTop, insecNode, contentType, location, match, collapse ? true : undefined);

    if (match && match.type != "whitelist" && insecNode) {
      // hide immediately if fastcollapse is off but not base types
      collapse = collapse || !prefs.fastcollapse;
      collapse = collapse && !(contentType in nonCollapsableTypes);
      hideNode(insecNode, insecWnd, collapse);
    }

    return (match && match.type == "whitelist") || (!match && linksOk);
  },

  // Tests whether some parent of the node is a link matching a filter
  checkLinks: function(insecNode) {
    while (insecNode) {
      var nodeLocation = unwrapURL(secureGet(insecNode, "href"));
      if (nodeLocation && this.isBlockableScheme(nodeLocation))
        break;

      insecNode = secureGet(insecNode, "parentNode");
    }

    if (insecNode)
      return this.processNode(insecNode, type.LINK, nodeLocation, false);
    else
      return true;
  },

  // Checks whether the location's scheme is blockable
  isBlockableScheme: function(location) {
    var url = makeURL(location);
    return (url && !(url.scheme.replace(/[^\w\-]/,"").toUpperCase() in whitelistSchemes));
  },

  // Checks whether the location's scheme is local
  isLocalScheme: function(location) {
    var url = makeURL(location);
    return (url && url.scheme.replace(/[^\w\-]/,"").toUpperCase() in localSchemes);
  },

  // Checks whether links should be checked for the specified type
  shouldCheckLinks: function(type) {
    return (type in linkTypes);
  },

  // Checks whether a page is whitelisted
  isWhitelisted: function(url) {
    return prefs.whitePatternsPage.matchesAny(url);
  },

  // Translates a space separated list of types into an object where properties corresponding
  // to the types listed are set to true
  translateTypeList: function(str) {
    var ret = {};
    var types = str.toUpperCase().split(" ");
    for (var i = 0; i < types.length; i++)
      if (types[i] in type)
        ret[type[types[i]]] = true;
    return ret;
  },

  // Translates a space separated list into an object where properties corresponding
  // to list entries are set to true
  translateList: function(str) {
    var ret = {};
    var list = str.toUpperCase().split(" ");
    for (var i = 0; i < list.length; i++)
      ret[list[i]] = true;
    return ret;
  },

  // nsIContentPolicy interface implementation
  shouldLoad: function(contentType, contentLocation, requestOrigin, insecNode, mimeTypeGuess, extra) {
    // if it's not a blockable type or a whitelisted scheme, use the usual policy
    var location = unwrapURL(contentLocation.spec);
    if (!(contentType in blockTypes && this.isBlockableScheme(location)))
      return ok;

    // handle old api
    if (oldStyleAPI && requestOrigin)
      insecNode = requestOrigin;  // Old API params: function(contentType, contentLocation, context, wnd)

    if (!insecNode)
      return ok;

    // New API will return the frame element, make it a window
    if (contentType == type.SUBDOCUMENT && secureGet(insecNode, "contentWindow"))
      insecNode = secureGet(insecNode, "contentWindow");

    // Old API requires us to QI the node
    if (oldStyleAPI) {
      try {
        insecNode = secureLookup(insecNode, "QueryInterface")(Components.interfaces.nsIDOMElement);
      } catch(e) {}
    }

    return (this.processNode(insecNode, contentType, location, false) ? ok : block);
  },

  shouldProcess: function(contentType, contentLocation, requestOrigin, insecNode, mimeType, extra) {
    return ok;
  }
};

abp.policy = policy;
