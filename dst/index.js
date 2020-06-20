"use strict";
var __spreadArrays = (this && this.__spreadArrays) || function () {
    for (var s = 0, i = 0, il = arguments.length; i < il; i++) s += arguments[i].length;
    for (var r = Array(s), k = 0, i = 0; i < il; i++)
        for (var a = arguments[i], j = 0, jl = a.length; j < jl; j++, k++)
            r[k] = a[j];
    return r;
};
Object.defineProperty(exports, "__esModule", { value: true });
var cfData = require("@crossfoam/data");
var d3_1 = require("d3");
var Graph = require("graphology");
var louvain = require("graphology-communities-louvain");
var jLouvain = require("jlouvain");
// TODO: Move this to something centralized or even config, so people can switch cluster-algos
var clusterAlgoId = 0;
var estimateCompletion = function (service, centralNode, nUuid, timestamp, uniqueID, queue) {
    return cfData.get("s--" + service + "--nw--" + centralNode)
        .then(function (networkData) {
        return cfData.get("s--" + service + "--a--" + centralNode + "-" + nUuid + "--n", {})
            .then(function (nodes) {
            var callCount = 0;
            var completeCount = 0;
            var completedNodes = 0;
            Object.keys(nodes).forEach(function (node) {
                var tCallCount = Math.ceil(nodes[node].friends_count / 5000);
                callCount += tCallCount;
                if (nodes[node].protected) {
                    completeCount += tCallCount;
                    completedNodes += 1;
                }
                else {
                    completeCount += Math.ceil(nodes[node].friends.length / 5000);
                    if (nodes[node].friends_count === 0 || nodes[node].friends.length > 0) {
                        completedNodes += 1;
                    }
                }
            });
            networkData[nUuid].completed = (completedNodes === Object.keys(nodes).length) ? true : false;
            networkData[nUuid].callCount = callCount;
            networkData[nUuid].nodeCount = Object.keys(nodes).length;
            networkData[nUuid].completeCount = completeCount;
            networkData[nUuid].lastUpdated = Date.now();
            if (queue && !queue.stillInQueue(nUuid, service + "--getFriendsIds")) {
                queue.call("network--checkupNetwork", [service, centralNode, nUuid], timestamp, uniqueID);
            }
            return cfData.set("s--" + service + "--nw--" + centralNode, networkData);
        });
    });
};
exports.estimateCompletion = estimateCompletion;
var buildNetwork = function (service, centralNode, nUuid, timestamp, uniqueID, queue) {
    return cfData.get("s--" + service + "--a--" + centralNode + "-" + nUuid + "--n")
        .then(function (network) {
        var edges = [];
        var edgesMap = {};
        var nodes = [];
        var nodesMap = {};
        var tempProxies = [];
        var tempProxiesMap = {};
        var proxyEdges = [];
        var proxies = [];
        var proxyKeys = {};
        var leafs = 0;
        var leafsMap = {};
        // Setup nodes
        Object.keys(network).forEach(function (nodeId) {
            if ("friends" in network[nodeId]) {
                // In order to save memory, we only save an array
                /*
                 * 0: id (int)
                 * 1: handle (string)
                 * 2: followers_count (int)
                 * 3: friends_count (int)
                 * 4: isProxy (0||1)
                 * 5: edge_count (int)
                 * 6: cluster
                 * 7: overview:r
                 * 8: overview:x
                 * 9: overview:y
                 * 10: network:r
                 * 11: network:x
                 * 12: network:y
                 * 13: friendCluster
                 * 14: image
                 * 15: name
                 * 16: protected
                 */
                nodes.push([
                    nodes.length,
                    network[nodeId].handle,
                    network[nodeId].followers_count,
                    network[nodeId].friends_count,
                    0,
                    0,
                    [[], []],
                    0,
                    0,
                    0,
                    0,
                    0,
                    0,
                    [{}, {}],
                    null,
                    null,
                    null,
                ]);
                nodesMap[nodeId] = nodes.length - 1;
            }
        });
        // Setup edges
        Object.keys(network).forEach(function (nodeId) {
            if ("friends" in network[nodeId]) {
                network[nodeId].friends.forEach(function (friendId) {
                    // make sure the friend exists in our network
                    if (friendId in network && ("friends" in network[friendId])) {
                        var connectionId = [nodesMap[nodeId], nodesMap[friendId]];
                        /*
                          * Strenth values:
                          * 1: Connection through a proxy
                          * 5: Connection to a centralNode friend > before 2
                          * 10: Double-sided connection to centralNode friend > before 3
                          */
                        var strength = 5;
                        if (network[friendId].friends.indexOf(nodeId) >= 0) {
                            // They follow each other, strong connection ?!
                            strength = 10;
                            connectionId.sort();
                        }
                        // Skip double sided connections
                        if (!(connectionId.join("-") in edgesMap)) {
                            // In order to save memory, we only save an array
                            /*
                             * 0: source
                             * 1: target
                             * 2: strength
                             * 3: proxyEdge (0 = no, 1 = with proxies, 2 = only proxies)
                             * 4: proxyStrength
                             */
                            edges.push(__spreadArrays(connectionId, [strength, 0, 0]));
                            edgesMap[connectionId.join("-")] = edges.length - 1;
                            connectionId.forEach(function (connection) {
                                nodes[connection][5] += 1;
                            });
                        }
                    }
                    else {
                        // This might be a proxy...
                        if (!(friendId in tempProxiesMap)) {
                            tempProxies.push([friendId, []]);
                            tempProxiesMap[friendId] = tempProxies.length - 1;
                        }
                        tempProxies[tempProxiesMap[friendId]][1].push(nodeId);
                    }
                });
            }
        });
        var proxyConnections = {};
        // Only add proxies to the network if they are at
        // least connected to two nodes within the network
        Object.keys(tempProxiesMap).forEach(function (tempProxyId) {
            var proxy = tempProxies[tempProxiesMap[tempProxyId]];
            if (proxy[1].length >= 2) {
                /*
                 * 0: id (int)
                 * 1: handle (string)
                 * 2: followers_count (int)
                 * 3: friends_count (int)
                 * 4: isProxy (0||1)
                 * 5: edge_count (int)
                 * 6: cluster
                 * 7: overview:r
                 * 8: overview:x
                 * 9: overview:y
                 * 10: network:r // removed for memory footprint
                 * 11: network:x // removed for memory footprint
                 * 12: network:y // removed for memory footprint
                 * 13: friendCluster // removed for memory footprint
                 * 14: image // removed for memory footprint
                 * 15: name // removed for memory footprint
                 * 16: protected // removed for memory footprint
                 */
                // TODO: Reduce proxy array, to save storage space
                proxies.push([
                    proxies.length,
                    proxy[0],
                    0,
                    0,
                    1,
                    proxy[1].length,
                    [[], []],
                    0,
                    0,
                    0,
                ]);
                // TODO: Maybe remove proxy keys for memory footprint
                proxyKeys[tempProxyId] = proxies.length - 1;
                proxy[1].forEach(function (connection) {
                    // Proxy edges are removed for now for memory footprint
                    // proxyEdges.push([
                    //   proxies.length - 1,
                    //   nodesMap[connection],
                    //   // 1,
                    // ]);
                    // // The weight for proxy connections is determined
                    // // by the overall size of the core nodes number of friends
                    // // as this is so far an undirected graph, the relative
                    // // weight of both friends is averaged 20% overlap === 1 weight
                    proxy[1].forEach(function (cconnection) {
                        if (connection !== cconnection) {
                            var connectionId = [nodesMap[connection], nodesMap[cconnection]]
                                .sort().join("-");
                            if (!(connectionId in proxyConnections)) {
                                proxyConnections[connectionId] = 0;
                            }
                            proxyConnections[connectionId] += 1;
                        }
                    });
                });
            }
            else if (!(proxy[0] in leafsMap)) {
                leafsMap[proxy[0]] = 1;
                leafs += 1;
            }
        });
        Object.keys(proxyConnections).forEach(function (connectionId) {
            var connections = connectionId.split("-");
            var connectionIdAlt = [connections[1], connections[0]].join("-");
            var connectionCount = proxyConnections[connectionId];
            var strength = (connectionCount / (nodes[connections[0]][3] / 3) +
                connectionCount / (nodes[connections[1]][3] / 3)) / 2;
            if (strength > 1) {
                strength = 1;
            }
            if (connectionId in edgesMap) {
                edges[edgesMap[connectionId]][4] += strength;
                edges[edgesMap[connectionId]][3] = 1;
            }
            else if (connectionIdAlt in edgesMap) {
                edges[edgesMap[connectionIdAlt]][4] += strength;
                edges[edgesMap[connectionIdAlt]][3] = 1;
            }
            else {
                edges.push(__spreadArrays(connections, [1, 2, strength]));
                edgesMap[connectionId] = edges.length - 1;
            }
        });
        // save some memory
        edges.forEach(function (edge) {
            edge[0] = parseInt(edge[0], 10);
            edge[1] = parseInt(edge[1], 10);
            edge[4] = parseFloat(edge[4].toFixed(2));
        });
        // And now save everything back into the storage
        return cfData.set("s--" + service + "--a--" + centralNode + "-" + nUuid + "--nw", {
            edges: edges,
            leafs: leafs,
            nodeKeys: nodesMap,
            nodes: nodes,
            proxies: proxies,
            proxyEdges: proxyEdges,
            proxyKeys: proxyKeys,
        })
            .then(function () {
            if (queue) {
                queue.call("network--analyseNetwork", [service, centralNode, nUuid], timestamp, uniqueID);
            }
            return Promise.resolve();
        });
    });
    return Promise.resolve();
};
exports.buildNetwork = buildNetwork;
var cycleIndex = function (max, index) {
    return index - max * Math.floor(index / max);
};
var applyCluster = function (clusters, clusterKey, data, id) {
    var defaultColors = [
        "#1AC9E7",
        "#FF3B7B",
        "#FF7D25",
        "#19E6D3",
        "#9644E7",
        "#FFD200",
        "#73DF36",
        "#3287FF",
        "#FF3524",
        "#DCE01A",
        "#F927BE",
        "#38BA77",
    ];
    if (!("cluster" in data)) {
        data.cluster = [];
    }
    data.cluster.push({
        clusters: {},
        name: clusterKey,
    });
    var tempClusters = {};
    Object.keys(clusters).forEach(function (cluster) {
        var clusterId = clusters[cluster];
        if (!(clusterId in tempClusters)) {
            tempClusters[clusterId] = [];
        }
        tempClusters[clusterId].push(cluster);
    });
    var clusterCount = 1;
    var clusterKeys = {};
    Object.keys(tempClusters).forEach(function (cluster) {
        if (tempClusters[cluster].length > 1) {
            data.cluster[id].clusters[cluster] = {
                color: defaultColors[cycleIndex(defaultColors.length, clusterCount)],
                edges: {},
                modified: false,
                name: "Cluster #" + clusterCount,
            };
            clusterCount += 1;
        }
    });
    data.nodes.forEach(function (node) {
        node[6][id].push(parseInt(clusters[node[0]], 10));
    });
    // TODO: Something is broken here...
    data.edges.forEach(function (edge) {
        for (var i = 0; i < 2; i += 1) {
            var counter = (i === 0) ? 1 : 0;
            var cluster = clusters[edge[i]];
            var counterCluster = clusters[edge[counter]];
            if (tempClusters[cluster].length > 1) {
                if (!(counterCluster in data.cluster[id].clusters[cluster].edges)) {
                    data.cluster[id].clusters[cluster].edges[counterCluster] = [0, 0, 0, 0];
                }
                if (edge[2] >= 2) { // CHECK: before 1
                    data.cluster[id].clusters[cluster].edges[counterCluster][0] += 1;
                    data.cluster[id].clusters[cluster].edges[counterCluster][1] += edge[2];
                }
                else {
                    data.cluster[id].clusters[cluster].edges[counterCluster][2] += 1;
                    data.cluster[id].clusters[cluster].edges[counterCluster][3] += edge[2];
                }
            }
            if (!(counterCluster in data.nodes[edge[i]][13][id])) {
                data.nodes[edge[i]][13][id][counterCluster] = [0, 0];
            }
            if (edge[2] >= 2) { // CHECK: before 1
                data.nodes[edge[i]][13][id][counterCluster][0] += 1;
            }
            else {
                data.nodes[edge[i]][13][id][counterCluster][1] += 1;
            }
        }
    });
    return data;
};
var analyseNetwork = function (service, centralNode, nUuid, timestamp, uniqueID, queue) {
    return cfData.get("s--" + service + "--a--" + centralNode + "-" + nUuid + "--nw")
        .then(function (data) {
        if (data.nodes.length > 0 && data.edges.length > 0) {
            // We implemented two different libraries for community detection,
            // in order to let users experience the uncertaintity of results
            // and the variety in produced communities
            /*------ Graphology (https://github.com/graphology) ------*/
            var graph_1 = new Graph({ type: "undirected" });
            data.nodes.forEach(function (node) {
                graph_1.addNode(node[0]);
            });
            data.edges.forEach(function (edge) {
                graph_1.addEdge(edge[0], edge[1], { weight: edge[2] });
            });
            var communities = louvain(graph_1, {
                attributes: {
                    community: "community",
                    weight: "weight",
                },
            });
            data = applyCluster(communities, "graphology", data, 0);
            /*------ jLouvain (https://github.com/upphiminn/jLouvain) ------*/
            var community = jLouvain.jLouvain()
                .nodes(data.nodes.map(function (node) { return node[0]; }))
                .edges(data.edges.map(function (edge) {
                return { source: edge[0], target: edge[1], weight: edge[2] };
            }));
            var result = community();
            data = applyCluster(result, "jLouvain", data, 1);
            return cfData.set("s--" + service + "--a--" + centralNode + "-" + nUuid + "--nw", data)
                .then(function () {
                if (queue) {
                    queue.call("network--visualizeNetwork", [service, centralNode, nUuid], timestamp, uniqueID, queue);
                }
                return Promise.resolve();
            });
        }
        else {
            // No viable network to analyse yet
            return Promise.resolve();
        }
    });
    return Promise.resolve();
};
exports.analyseNetwork = analyseNetwork;
var visualizeNetwork = function (serviceKey, centralNode, nUuid, timestamp, uniqueID, queue) {
    return new Promise(function (resolve, reject) {
        // preCalculate network positions and store
        // run an analysis of the network, etc.
        cfData.get("s--" + serviceKey + "--a--" + centralNode + "-" + nUuid + "--nw")
            .then(function (data) {
            if (!Array.isArray(data.leafs)) {
                data.leafs = d3_1.range(data.leafs).map(function (leaf) {
                    return [
                        1,
                        0,
                        0,
                    ];
                });
            }
            var positionPrecision = 2;
            var innerRadius = 30;
            var radiusScale = d3_1.scaleLinear()
                .domain([0, d3_1.max(data.nodes, function (d) { return d[5]; })])
                .range([1, 5]);
            var rotation = 2 * Math.PI;
            var awayStep = 1.1;
            var chord = 5;
            var theta = chord / awayStep;
            var nodes = data.nodes.map(function (d, di) {
                var away = awayStep * theta + innerRadius - 5;
                var around = theta + rotation;
                theta += chord / away;
                return {
                    delay: 0,
                    id: di,
                    level: 0,
                    oid: d[0],
                    proxy: false,
                    r: radiusScale(d[5]),
                    x: Math.cos(around) * away,
                    y: Math.sin(around) * away,
                };
            });
            nodes.push({
                fixed: true,
                fx: 0,
                fy: 0,
                r: innerRadius,
                x: 0,
                y: 0,
            });
            var workerOverview = new Worker("../assets/js/workerVisOverview.js");
            workerOverview.onmessage = function (event) {
                var maxDist = 0;
                var targetNodes;
                var nodeBase;
                var keyOffset = 0;
                var workerLimit = 30;
                switch (event.data.level) {
                    case 0:
                        targetNodes = data.nodes;
                        nodeBase = data.proxies;
                        radiusScale.domain([0, d3_1.max(data.proxies, function (d) { return d[5]; })]);
                        keyOffset = 7;
                        break;
                    case 1:
                        targetNodes = data.proxies;
                        nodeBase = data.leafs;
                        keyOffset = 7;
                        workerLimit = 20;
                        break;
                    case 2:
                        targetNodes = data.leafs;
                        break;
                }
                event.data.nodes.forEach(function (n, ni) {
                    if (!("fixed" in n) || n.fixed === false) {
                        targetNodes[n.id][keyOffset] = parseFloat(n.r.toFixed(positionPrecision));
                        targetNodes[n.id][keyOffset + 1] = parseFloat(n.x.toFixed(positionPrecision));
                        targetNodes[n.id][keyOffset + 2] = parseFloat(n.y.toFixed(positionPrecision));
                    }
                    var dist = Math.sqrt(n.x * n.x + n.y * n.y) + n.r;
                    if (dist > maxDist) {
                        maxDist = dist;
                    }
                });
                if (event.data.level < 2) {
                    // TODO: Maybe store the dist-radi somewhere
                    var extraDist = (event.data.level === 0) ? 10 : 5;
                    theta = chord / awayStep;
                    var nextNodes = nodeBase.map(function (d, di) {
                        var away = awayStep * theta + maxDist;
                        var around = theta + rotation;
                        theta += chord / away;
                        return {
                            id: di,
                            level: event.data.level + 1,
                            oid: (event.data.level === 0) ? d[0] : di,
                            proxy: true,
                            r: (event.data.level === 0) ? radiusScale(d[5]) : 1,
                            x: Math.cos(around) * away,
                            y: Math.sin(around) * away,
                        };
                    });
                    nextNodes.push({
                        fixed: true,
                        fx: 0,
                        fy: 0,
                        r: maxDist + extraDist * 2,
                        x: 0,
                        y: 0,
                    });
                    workerOverview.postMessage({
                        innerRadius: maxDist + extraDist * 2,
                        level: event.data.level + 1,
                        limit: workerLimit,
                        nodes: nextNodes,
                    });
                }
                else {
                    workerOverview.terminate();
                    var networkNodes_1 = [];
                    radiusScale
                        .domain([0, d3_1.max(data.nodes, function (d) { return d[5]; })])
                        .range([5, 25]);
                    data.nodes.forEach(function (n, ni) {
                        networkNodes_1.push({
                            id: n[0],
                            index: n[0],
                            oid: ni,
                            r: radiusScale(n[5]),
                        });
                    });
                    var networkEdges_1 = [];
                    data.edges.forEach(function (e, ei) {
                        if (e[2] >= 2) {
                            networkEdges_1.push({
                                source: e[0],
                                target: e[1],
                                weight: e[2],
                            });
                        }
                    });
                    workerNetwork.postMessage({
                        edges: networkEdges_1,
                        nodes: networkNodes_1,
                    });
                }
            };
            var workerNetwork = new Worker("../assets/js/workerVisNetwork.js");
            workerNetwork.onmessage = function (event) {
                event.data.nodes.forEach(function (n, ni) {
                    data.nodes[n.oid][10] = parseFloat(n.r.toFixed(positionPrecision));
                    data.nodes[n.oid][11] = parseFloat(n.x.toFixed(positionPrecision));
                    data.nodes[n.oid][12] = parseFloat(n.y.toFixed(positionPrecision));
                });
                workerNetwork.terminate();
                // TODO: run pre-vis for analysis
                cfData.set("s--" + serviceKey + "--a--" + centralNode + "-" + nUuid + "--nw", data)
                    .then(function (returnData) {
                    if (data.proxies.length > 0 && queue) {
                        queue.call(serviceKey + "--getUsers", [centralNode, nUuid], timestamp, uniqueID);
                    }
                    updateNetworkDictionary(serviceKey, centralNode, nUuid, timestamp, uniqueID, queue)
                        .then(function () {
                        resolve();
                    })
                        .catch(function (err) {
                        reject(err);
                    });
                });
            };
            workerOverview.postMessage({
                innerRadius: innerRadius,
                level: 0,
                limit: 40,
                nodes: nodes,
            });
        }).catch(function (err) {
            reject(err);
        });
    });
};
exports.visualizeNetwork = visualizeNetwork;
var updateNetworkDictionary = function (serviceKey, centralNode, nUuid, timestamp, uniqueID, queue) {
    return Promise.all([
        cfData.get("s--" + serviceKey + "--a--" + centralNode + "-" + nUuid + "--nw", {}),
        cfData.get("s--" + serviceKey + "--d", { cluster: [], nodes: {} }),
    ]).then(function (data) {
        var clusterKeys = {};
        data[1].cluster.forEach(function (cluster, ci) {
            clusterKeys[cluster.id.join("-")] = ci;
        });
        if ("cluster" in data[0]) {
            var cluster_1 = data[0].cluster[clusterAlgoId];
            Object.keys(cluster_1.clusters).forEach(function (clusterId) {
                if (("modified" in cluster_1.clusters[clusterId]) && cluster_1.clusters[clusterId].modified === true) {
                    var tId = nUuid + "-" + clusterAlgoId + "-" + clusterId;
                    if (!(tId in clusterKeys)) {
                        clusterKeys[tId] = data[1].cluster.length;
                        data[1].cluster.push({
                            color: cluster_1.clusters[clusterId].color,
                            id: [nUuid, clusterAlgoId, clusterId],
                            name: cluster_1.clusters[clusterId].name,
                        });
                    }
                }
            });
            // TODO: Apply Clusters to proxies [, data[0].proxies]
            [data[0].nodes].forEach(function (nodes) {
                nodes.forEach(function (node) {
                    var userCluster = node[6][clusterAlgoId];
                    userCluster.forEach(function (clusterId) {
                        if (!(node[1] in data[1].nodes)) {
                            data[1].nodes[node[1]] = [];
                        }
                        var tId = nUuid + "-" + clusterAlgoId + "-" + clusterId;
                        if (tId in clusterKeys && data[1].nodes[node[1]].indexOf(clusterKeys[tId]) === -1) {
                            data[1].nodes[node[1]].push(clusterKeys[tId]);
                        }
                    });
                });
            });
        }
        queue.call("updateDictionary", [], timestamp, uniqueID);
        return cfData.set("s--" + serviceKey + "--d", data[1]);
    });
};
exports.updateNetworkDictionary = updateNetworkDictionary;
var checkupNetwork = function (serviceKey, centralNode, nUuid, timestamp, uniqueID, queue) {
    return cfData.get("s--" + serviceKey + "--a--" + centralNode + "-" + nUuid + "--n", {})
        .then(function (nodes) {
        var somethingMissing = false;
        Object.keys(nodes).forEach(function (node) {
            if (!nodes[node].protected &&
                // what if the user adds or removes friends while we scrape? > tolerance of 10
                // TODO: do we need to recheck the number of friends?
                (nodes[node].friends_count !== 0 &&
                    (!("friends" in nodes[node])
                        || nodes[node].friends.length === 0))) {
                somethingMissing = true;
                if (queue) {
                    // console.log("something missing " + node, nodes[node]);
                    queue.call(serviceKey + "--getFriendsIds", [undefined, node, centralNode, nUuid, -1], timestamp, uniqueID);
                }
            }
        });
        if (!somethingMissing) {
            return buildNetwork(serviceKey, centralNode, nUuid, timestamp, uniqueID, queue);
        }
    });
};
exports.checkupNetwork = checkupNetwork;
var removeNetwork = function (serviceKey, centralNode, nUuid) {
    return Promise.all([
        cfData.remove("s--" + serviceKey + "--a--" + centralNode + "-" + nUuid + "--nw"),
        cfData.remove("s--" + serviceKey + "--a--" + centralNode + "-" + nUuid + "--n"),
    ]).then(function () {
        return cfData.get("s--" + serviceKey + "--nw--" + centralNode, {});
    }).then(function (networkData) {
        delete networkData[nUuid];
        return cfData.set("s--" + serviceKey + "--nw--" + centralNode, networkData);
    }).then(function () {
        return Promise.resolve();
    });
};
exports.removeNetwork = removeNetwork;
var cleanupNetwork = function (serviceKey, centralNode, nUuid) {
    return Promise.all([
        cfData.get("s--" + serviceKey + "--a--" + centralNode + "-" + nUuid + "--n", {}),
        cfData.get("s--" + serviceKey + "--a--" + centralNode + "-" + nUuid + "--nw", { nodes: [], nodeKeys: {} }),
    ]).then(function (data) {
        Object.keys(data[0]).forEach(function (nodeKey) {
            if (nodeKey in data[1].nodeKeys) {
                var nodeId = data[1].nodeKeys[nodeKey];
                data[1].nodes[nodeId][14] = data[0][nodeKey].image;
                data[1].nodes[nodeId][15] = data[0][nodeKey].name;
                data[1].nodes[nodeId][16] = data[0][nodeKey].protected;
            }
            else if (nodeKey in data[1].proxyKeys) {
                var nodeId = data[1].proxyKeys[nodeKey];
                data[1].proxies[nodeId][2] = data[0][nodeKey].friends_count;
                data[1].proxies[nodeId][3] = data[0][nodeKey].followers_count;
                data[1].proxies[nodeId][1] = data[0][nodeKey].handle;
                // different index for image, name and protected on proxies (memory saving)
                data[1].proxies[nodeId][10] = data[0][nodeKey].image;
                data[1].proxies[nodeId][11] = data[0][nodeKey].name;
                data[1].proxies[nodeId][12] = data[0][nodeKey].protected;
            }
            else {
                // console.log("where did this come from?", nodeKey);
            }
        });
        return cfData.set("s--" + serviceKey + "--a--" + centralNode + "-" + nUuid + "--nw", data[1]);
    }).then(function () {
        return cfData.remove("s--" + serviceKey + "--a--" + centralNode + "-" + nUuid + "--n");
    }).then(function () {
        browser.notifications.create("crossfoam-scrapeDone-" + nUuid, {
            iconUrl: browser.runtime.getURL("assets/icons/icon-96.png"),
            message: "Crossfoam finished collecting and analysing the data.",
            title: centralNode + " finished!",
            type: "basic",
        });
        browser.browserAction.onClicked.addListener(function () {
            browser.notifications.clear("crossfoam-scrapeDone")
                .then(function () {
                browser.tabs.create({
                    url: "/html/vis.html?view=vis&service=" + serviceKey + "&centralNode=" + centralNode + "&nUuid=" + nUuid,
                }).then(function (results) {
                    // successful opening vis.html
                }, function (err) {
                    throw err;
                });
            });
        });
        return Promise.resolve();
    });
};
exports.cleanupNetwork = cleanupNetwork;
/*----- Worker Functions -----*/
var workerOverviewNetwork = function (event) {
    var nodes = event.data.nodes;
    var simulation = d3_1.forceSimulation(nodes)
        .force("charge", d3_1.forceCollide().radius(function (d) { return d.r + 2; }))
        // TODO: insert the radial force in the middle of the ring ??
        // .force("r", d3.forceRadial(event.data.innerRadius))
        .stop();
    for (var i = 0, n = Math.ceil(Math.log(simulation.alphaMin()) / Math.log(1 - simulation.alphaDecay())); i < n && i < event.data.limit; i += 1) {
        simulation.tick();
    }
    return {
        level: event.data.level,
        nodes: nodes,
    };
};
exports.workerOverviewNetwork = workerOverviewNetwork;
var workerForceNetwork = function (event) {
    var nodes = event.data.nodes;
    var edges = event.data.edges;
    var simulation = d3_1.forceSimulation(nodes)
        .force("charge", d3_1.forceManyBody()) // .strength(-300)
        .force("link", d3_1.forceLink(edges).distance(50).strength(1))
        .force("center", d3_1.forceCenter(0, 0))
        .force("charge", d3_1.forceCollide().radius(function (d) { return d.r + 15; }).strength(1).iterations(10))
        .alphaDecay(1 - Math.pow(0.001, 1 / (300 + Math.pow(nodes.length / 3, 2.3) / 30)))
        .stop();
    for (var i = 0, n = Math.ceil(Math.log(simulation.alphaMin()) / Math.log(1 - simulation.alphaDecay())); i < n; i += 1) {
        simulation.tick();
    }
    return {
        nodes: nodes,
    };
};
exports.workerForceNetwork = workerForceNetwork;
//# sourceMappingURL=index.js.map