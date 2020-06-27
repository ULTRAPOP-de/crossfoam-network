import * as cfData from "@crossfoam/data";
import { forceCenter, forceCollide, forceLink, forceManyBody,
         forceSimulation, max as d3Max, range, scaleLinear } from "d3";
import * as Graph from "graphology";
import * as louvain from "graphology-communities-louvain";
import * as jLouvain from "jlouvain";

// TODO: Move this to something centralized or even config, so people can switch cluster-algos
const clusterAlgoId = 0;

const estimateCompletion = (service: string, centralNode: string, nUuid: string,
                            timestamp?: number, uniqueID?: string, queue?: any): Promise<any> => {

  return cfData.get(`s--${service}--nw--${centralNode}`)
    .then((networkData) => {
      return cfData.get(`s--${service}--a--${centralNode}-${nUuid}--n`, {})
        .then((nodes) => {

          let callCount = 0;
          let completeCount = 0;
          let completedNodes = 0;
          Object.keys(nodes).forEach((node) => {
            const tCallCount = Math.ceil(nodes[node].friends_count / 5000);
            callCount += tCallCount;

            if (nodes[node].protected) {
              completeCount += tCallCount;
              completedNodes += 1;
            } else {
              completeCount += Math.ceil(nodes[node].friends.length / 5000);
              if ( nodes[node].friends_count === 0 || nodes[node].friends.length > 0) {
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
            queue.call("network--checkupNetwork", [service, centralNode, nUuid],
              timestamp, uniqueID);
          }

          return cfData.set(`s--${service}--nw--${centralNode}`, networkData);
        });
    });
};

const buildNetwork = (service: string, centralNode: string, nUuid: string,
                      timestamp?: number, uniqueID?: string, queue?: any): Promise<any> => {

  return cfData.get(`s--${service}--a--${centralNode}-${nUuid}--n`)
    .then((network) => {
      const edges = [];
      const edgesMap = {};
      const nodes = [];
      const nodesMap = {};
      const tempProxies = [];
      const tempProxiesMap = {};
      const proxyEdges = [];
      const proxies = [];
      const proxyKeys = {};
      let leafs = 0;
      const leafsMap = {};

      // Setup nodes
      Object.keys(network).forEach((nodeId) => {
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
            [[], []], // If number of clusters change update this
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
      Object.keys(network).forEach((nodeId) => {
        if ("friends" in network[nodeId]) {
          network[nodeId].friends.forEach((friendId) => {
            // make sure the friend exists in our network
            if (friendId in network  && ("friends" in network[friendId])) {
              const connectionId = [nodesMap[nodeId], nodesMap[friendId]];

              /*
                * Strenth values:
                * 1: Connection through a proxy
                * 5: Connection to a centralNode friend > before 2
                * 10: Double-sided connection to centralNode friend > before 3
                */
              let strength = 5;

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
                edges.push([...connectionId, strength, 0, 0]);
                edgesMap[connectionId.join("-")] = edges.length - 1;

                connectionId.forEach((connection) => {
                  nodes[connection][5] += 1;
                });
              }
            } else {
              // This might be a proxy...
              if (! (friendId in tempProxiesMap)) {
                tempProxies.push([friendId, []]);
                tempProxiesMap[friendId] = tempProxies.length - 1;
              }
              tempProxies[tempProxiesMap[friendId]][1].push(nodeId);
            }
          });
        }
      });

      const proxyConnections = {};

      // Only add proxies to the network if they are at
      // least connected to two nodes within the network
      Object.keys(tempProxiesMap).forEach((tempProxyId) => {
        const proxy = tempProxies[tempProxiesMap[tempProxyId]];
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
            // 0,
            // 0,
            // 0,
            // [{}, {}],
            // null,
            // null,
            // null,
          ]);

          // TODO: Maybe remove proxy keys for memory footprint
          proxyKeys[tempProxyId] = proxies.length - 1;

          proxy[1].forEach((connection) => {
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

            proxy[1].forEach((cconnection) => {

              if (connection !== cconnection) {

                const connectionId = [nodesMap[connection], nodesMap[cconnection]]
                  .sort().join("-");

                if (!(connectionId in proxyConnections)) {
                  proxyConnections[connectionId] = 0;
                }

                proxyConnections[connectionId] += 1;

              }

            });

          });
        } else if (!(proxy[0] in leafsMap)) {
          leafsMap[proxy[0]] = 1;
          leafs += 1;
        }
      });

      Object.keys(proxyConnections).forEach((connectionId) => {
        const connections = connectionId.split("-");
        const connectionIdAlt = [connections[1], connections[0]].join("-");
        const connectionCount = proxyConnections[connectionId];

        let strength = (connectionCount / (nodes[connections[0]][3] / 3) +
          connectionCount / (nodes[connections[1]][3] / 3)) / 2;

        if (strength > 1) {
          strength = 1;
        }

        if (connectionId in edgesMap) {
          edges[edgesMap[connectionId]][4] += strength;
          edges[edgesMap[connectionId]][3] = 1;
        } else if (connectionIdAlt in edgesMap) {
          edges[edgesMap[connectionIdAlt]][4] += strength;
          edges[edgesMap[connectionIdAlt]][3] = 1;
        } else {
          edges.push([...connections, 1, 2, strength]);
          edgesMap[connectionId] = edges.length - 1;
        }
      });

      // save some memory
      edges.forEach((edge) => {
        edge[0] = parseInt(edge[0], 10);
        edge[1] = parseInt(edge[1], 10);
        edge[4] = parseFloat(edge[4].toFixed(2));
      });

      // And now save everything back into the storage
      return cfData.set(`s--${service}--a--${centralNode}-${nUuid}--nw`, {
        edges,
        leafs,
        nodeKeys: nodesMap,
        nodes,
        proxies,
        proxyEdges,
        proxyKeys,
      })
      .then(() => {
        if (queue) {
          queue.call("network--analyseNetwork", [service, centralNode, nUuid], timestamp, uniqueID);
        }
        return Promise.resolve();
      });
    });
  return Promise.resolve();
};

const cycleIndex = (max, index) => {
  return index - max * Math.floor(index / max);
};

const applyCluster = (clusters, clusterKey: string, data, id: number) => {
  const defaultColors = [
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

  const tempClusters = {};

  Object.keys(clusters).forEach((cluster) => {
    const clusterId = clusters[cluster];
    if (!(clusterId in tempClusters)) {
      tempClusters[clusterId] = [];
    }
    tempClusters[clusterId].push(cluster);
  });

  let clusterCount = 1;
  const clusterKeys = {};

  Object.keys(tempClusters).forEach((cluster) => {
    if (tempClusters[cluster].length > 1) {
      data.cluster[id].clusters[cluster] = {
        color: defaultColors[cycleIndex(defaultColors.length, clusterCount)],
        edges: {},
        modified: false,
        name: `Cluster #${clusterCount}`,
      };
      clusterCount += 1;
    }
  });

  data.nodes.forEach((node) => {
    node[6][id].push(parseInt(clusters[node[0]], 10));
  });

  // TODO: Something is broken here...
  data.edges.forEach((edge) => {
    for (let i = 0; i < 2; i += 1) {
      const counter = (i === 0) ? 1 : 0;
      const cluster = clusters[edge[i]];
      const counterCluster = clusters[edge[counter]];

      if (tempClusters[cluster].length > 1) {
        if (!(counterCluster in data.cluster[id].clusters[cluster].edges)) {
          data.cluster[id].clusters[cluster].edges[counterCluster] = [0, 0, 0, 0];
        }

        if (edge[2] >= 2) { // CHECK: before 1
          data.cluster[id].clusters[cluster].edges[counterCluster][0] += 1;
          data.cluster[id].clusters[cluster].edges[counterCluster][1] += edge[2];
        } else {
          data.cluster[id].clusters[cluster].edges[counterCluster][2] += 1;
          data.cluster[id].clusters[cluster].edges[counterCluster][3] += edge[2];
        }
      }

      if (!(counterCluster in data.nodes[edge[i]][13][id])) {
        data.nodes[edge[i]][13][id][counterCluster] = [0, 0];
      }

      if (edge[2] >= 2) { // CHECK: before 1
        data.nodes[edge[i]][13][id][counterCluster][0] += 1;
      } else {
        data.nodes[edge[i]][13][id][counterCluster][1] += 1;
      }
    }
  });

  return data;
};

const analyseNetwork = (service: string, centralNode: string, nUuid: string,
                        timestamp?: number, uniqueID?: string, queue?: any): Promise<any> => {

  return cfData.get(`s--${service}--a--${centralNode}-${nUuid}--nw`)
    .then((data) => {

      if (data.nodes.length > 0 && data.edges.length > 0) {

        // We implemented two different libraries for community detection,
        // in order to let users experience the uncertaintity of results
        // and the variety in produced communities

        /*------ Graphology (https://github.com/graphology) ------*/

        const graph = new Graph({type: "undirected"});

        data.nodes.forEach((node) => {
          graph.addNode(node[0]);
        });

        data.edges.forEach((edge) => {
          graph.addEdge(edge[0], edge[1], { weight: edge[2] });
        });

        const communities = louvain(graph, {
          attributes: {
            community: "community",
            weight: "weight",
          },
        });

        data = applyCluster(communities, "graphology", data, 0);

        /*------ jLouvain (https://github.com/upphiminn/jLouvain) ------*/

        const community = jLouvain.jLouvain()
          .nodes(data.nodes.map((node) => node[0]))
          .edges(data.edges.map((edge) => {
            return {source: edge[0], target: edge[1], weight: edge[2]};
          }));

        const result  = community();

        data = applyCluster(result, "jLouvain", data, 1);

        return cfData.set(`s--${service}--a--${centralNode}-${nUuid}--nw`, data)
          .then(() => {
            if (queue) {
              queue.call("network--visualizeNetwork", [service, centralNode, nUuid], timestamp, uniqueID, queue);
            }
            return Promise.resolve();
          });
     } else {
       // No viable network to analyse yet
       return Promise.resolve();
     }
   });
  return Promise.resolve();
};

const visualizeNetwork = (serviceKey: string, centralNode: string, nUuid: string,
                          timestamp?: number, uniqueID?: string, queue?: any): Promise<any> => {

  return new Promise((resolve, reject) => {

    // preCalculate network positions and store
    // run an analysis of the network, etc.
    cfData.get(`s--${serviceKey}--a--${centralNode}-${nUuid}--nw`)
      .then((data) => {

        if (!Array.isArray(data.leafs)) {
          data.leafs = range(data.leafs).map((leaf) => {
            return [
              1, // r
              0, // x
              0, // y
            ];
          });
        }

        const positionPrecision = 2;
        const innerRadius = 30;

        const radiusScale = scaleLinear()
          .domain([0, d3Max(data.nodes, (d) => d[5])])
          .range([1, 5]);

        const rotation = 2 * Math.PI;
        const awayStep = 1.1;
        const chord = 5;

        let theta = chord / awayStep;
        const nodes = data.nodes.map((d, di) => {
          const away = awayStep * theta + innerRadius - 5;
          const around = theta + rotation;
          theta += chord / away;

          return {
            delay: 0,
            id: di,
            level: 0,
            oid: d[0],
            proxy: false,
            r: radiusScale(d[5]),
            x: Math.cos ( around ) * away,
            y: Math.sin ( around ) * away,
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

        const workerOverview = new Worker("../assets/js/workerVisOverview.js");

        workerOverview.onmessage = (event) => {

          let maxDist = 0;
          let targetNodes;
          let nodeBase;
          let keyOffset = 0;
          let workerLimit = 30;

          switch (event.data.level) {
            case 0:
              targetNodes = data.nodes;
              nodeBase = data.proxies;
              radiusScale.domain([0, d3Max(data.proxies, (d) => d[5])]);
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

          event.data.nodes.forEach((n, ni) => {
            if ( !("fixed" in n) || n.fixed === false) {
              targetNodes[n.id][keyOffset] = parseFloat(n.r.toFixed(positionPrecision));
              targetNodes[n.id][keyOffset + 1] = parseFloat(n.x.toFixed(positionPrecision));
              targetNodes[n.id][keyOffset + 2] = parseFloat(n.y.toFixed(positionPrecision));
            }

            const dist = Math.sqrt(n.x * n.x + n.y * n.y) + n.r;
            if (dist > maxDist) {
              maxDist = dist;
            }
          });

          if (event.data.level < 2) {

            // TODO: Maybe store the dist-radi somewhere
            const extraDist = (event.data.level === 0) ? 10 : 5;

            theta = chord / awayStep;
            const nextNodes = nodeBase.map((d, di) => {
              const away = awayStep * theta + maxDist;
              const around = theta + rotation;
              theta += chord / away;

              return {
                id: di,
                level: event.data.level + 1,
                oid: (event.data.level === 0) ? d[0] : di,
                proxy: true,
                r: (event.data.level === 0) ? radiusScale(d[5]) : 1,
                x: Math.cos ( around ) * away,
                y: Math.sin ( around ) * away,
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

          } else {

            workerOverview.terminate();

            const networkNodes = [];

            radiusScale
              .domain([0, d3Max(data.nodes, (d) => d[5])])
              .range([5, 25]);

            data.nodes.forEach((n, ni) => {
              networkNodes.push({
                id: n[0],
                index: n[0],
                oid: ni,
                r: radiusScale(n[5]),
              });
            });

            const networkEdges = [];

            data.edges.forEach((e, ei) => {
              if (e[2] >= 2) {
                networkEdges.push({
                  source: e[0],
                  target: e[1],
                  weight: e[2],
                });
              }
            });

            workerNetwork.postMessage({
              edges: networkEdges,
              nodes: networkNodes,
            });
          }
        };

        const workerNetwork = new Worker("../assets/js/workerVisNetwork.js");

        workerNetwork.onmessage = (event) => {
          event.data.nodes.forEach((n, ni) => {
            data.nodes[n.oid][10] = parseFloat(n.r.toFixed(positionPrecision));
            data.nodes[n.oid][11] = parseFloat(n.x.toFixed(positionPrecision));
            data.nodes[n.oid][12] = parseFloat(n.y.toFixed(positionPrecision));
          });

          workerNetwork.terminate();

          // TODO: run pre-vis for analysis
          cfData.set(`s--${serviceKey}--a--${centralNode}-${nUuid}--nw`, data)
            .then((returnData) => {

              if (data.proxies.length > 0 && queue) {
                queue.call(serviceKey + "--getUsers",
                   [centralNode, nUuid],
                   timestamp, uniqueID);
              }

              updateNetworkDictionary(serviceKey, centralNode, nUuid, timestamp, uniqueID, queue)
                .then(() => {
                  resolve();
                })
                .catch((err) => {
                  reject(err);
                });
            });
        };

        workerOverview.postMessage({
          innerRadius,
          level: 0,
          limit: 40,
          nodes,
        });

      }).catch((err) => {
        reject(err);
      });
  });
};

const updateNetworkDictionary = (serviceKey: string, centralNode: string, nUuid: string,
                                 timestamp?: number, uniqueID?: string, queue?: any): Promise<any> => {
  return Promise.all([
    cfData.get(`s--${serviceKey}--a--${centralNode}-${nUuid}--nw`, {}),
    cfData.get(`s--${serviceKey}--d`, {cluster: [], nodes: {}, altNodes: {}}),
  ]).then((data) => {

    // migration
    if (!("altNodes" in data[1])) {
      data[1].altNodes = {};
    }

    const reverseKeyMap = [{}, {}];
    Object.keys(data[0].nodeKeys).forEach((nodeId) => {
      reverseKeyMap[0][data[0].nodeKeys[nodeId]] = nodeId;
    });
    Object.keys(data[0].proxyKeys).forEach((nodeId) => {
      reverseKeyMap[1][data[0].nodeKeys[nodeId]] = nodeId;
    });

    const clusterKeys = {};
    data[1].cluster.forEach((cluster, ci) => {
      clusterKeys[cluster.id.join("-")] = ci;
    });

    if ("cluster" in data[0]) {
      const cluster = data[0].cluster[clusterAlgoId];
      Object.keys(cluster.clusters).forEach((clusterId) => {
        if (("modified" in cluster.clusters[clusterId]) && cluster.clusters[clusterId].modified === true) {
          const tId = `${nUuid}-${clusterAlgoId}-${clusterId}`;
          if (!(tId in clusterKeys)) {
            clusterKeys[tId] = data[1].cluster.length;

            data[1].cluster.push({
              color: cluster.clusters[clusterId].color,
              id: [nUuid, clusterAlgoId, clusterId],
              name: cluster.clusters[clusterId].name,
            });
          }
        }
      });

      [data[0].nodes, data[0].proxies].forEach((nodes, ni) => {
        nodes.forEach((node, nodeIndex) => {
          const userCluster = node[6][clusterAlgoId];
          userCluster.forEach((clusterId) => {
            if (!(node[1] in data[1].nodes)) {
              data[1].nodes[node[1]] = [];
            }

            if (nodeIndex in reverseKeyMap[ni]) {
              if (!(reverseKeyMap[ni][nodeIndex] in data[1].altNodes)) {
                data[1].altNodes[reverseKeyMap[ni][nodeIndex]] = node[1];
              }
            }

            const tId = `${nUuid}-${clusterAlgoId}-${clusterId}`;
            if (tId in clusterKeys && data[1].nodes[node[1]].indexOf(clusterKeys[tId]) === -1) {
              data[1].nodes[node[1]].push(clusterKeys[tId]);
            }
          });
        });
      });
    }

    return cfData.set(`s--${serviceKey}--d`, data[1]);
  })
  .then(() => {
    if (queue) {
      queue.call("updateDictionary", [], timestamp, uniqueID);
    }
    return Promise.resolve();
  });
};

const checkupNetwork = (serviceKey: string, centralNode: string, nUuid: string,
                        timestamp?: number, uniqueID?: string, queue?: any): Promise<any> => {

  return cfData.get(`s--${serviceKey}--a--${centralNode}-${nUuid}--n`, {})
    .then((nodes) => {

      let somethingMissing = false;

      Object.keys(nodes).forEach((node) => {

        if (
          !nodes[node].protected &&
          // what if the user adds or removes friends while we scrape? > tolerance of 10
          // TODO: do we need to recheck the number of friends?
          (
            nodes[node].friends_count !== 0 &&
            (
              !("friends" in nodes[node])
              || nodes[node].friends.length === 0
            )
          )
        ) {
          somethingMissing = true;
          if (queue) {
            // console.log("something missing " + node, nodes[node]);

            queue.call(serviceKey + "--getFriendsIds", [undefined, node, centralNode, nUuid, -1],
              timestamp, uniqueID);
          }
        }
      });

      if (!somethingMissing) {
        return buildNetwork(serviceKey, centralNode, nUuid, timestamp, uniqueID, queue);
      }

    });

};

const removeNetwork = (serviceKey: string, centralNode: string, nUuid: string): Promise<any> => {
  return Promise.all([
    cfData.remove(`s--${serviceKey}--a--${centralNode}-${nUuid}--nw`),
    cfData.remove(`s--${serviceKey}--a--${centralNode}-${nUuid}--n`),
  ]).then(() => {
    return cfData.get(`s--${serviceKey}--nw--${centralNode}`, {});
  }).then((networkData) => {
    delete networkData[nUuid];
    return cfData.set(`s--${serviceKey}--nw--${centralNode}`, networkData);
  }).then(() => {
    return Promise.resolve();
  });
};

const cleanupNetwork = (serviceKey: string, centralNode: string, nUuid: string): Promise<any> => {
  return Promise.all([
    cfData.get(`s--${serviceKey}--a--${centralNode}-${nUuid}--n`, {}),
    cfData.get(`s--${serviceKey}--a--${centralNode}-${nUuid}--nw`, {nodes: [], nodeKeys: {}}),
  ]).then((data) => {
    Object.keys(data[0]).forEach((nodeKey) => {
      if (nodeKey in data[1].nodeKeys) {
        const nodeId = data[1].nodeKeys[nodeKey];
        data[1].nodes[nodeId][14] = data[0][nodeKey].image;
        data[1].nodes[nodeId][15] = data[0][nodeKey].name;
        data[1].nodes[nodeId][16] = data[0][nodeKey].protected;
      } else if (nodeKey in data[1].proxyKeys) {
        const nodeId = data[1].proxyKeys[nodeKey];
        data[1].proxies[nodeId][2] = data[0][nodeKey].friends_count;
        data[1].proxies[nodeId][3] = data[0][nodeKey].followers_count;
        data[1].proxies[nodeId][1] = data[0][nodeKey].handle;
        // different index for image, name and protected on proxies (memory saving)
        data[1].proxies[nodeId][10] = data[0][nodeKey].image;
        data[1].proxies[nodeId][11] = data[0][nodeKey].name;
        data[1].proxies[nodeId][12] = data[0][nodeKey].protected;
      } else {
        // console.log("where did this come from?", nodeKey);
      }
    });

    return cfData.set(`s--${serviceKey}--a--${centralNode}-${nUuid}--nw`, data[1]);
  }).then(() => {
    return cfData.remove(`s--${serviceKey}--a--${centralNode}-${nUuid}--n`);
  }).then(() => {
    browser.notifications.create("crossfoam-scrapeDone-" + nUuid, {
      iconUrl: browser.runtime.getURL("assets/icons/icon-96.png"),
      message: "Crossfoam finished collecting and analysing the data.",
      title: centralNode + " finished!",
      type: "basic",
    });

    browser.browserAction.onClicked.addListener(() => {
      browser.notifications.clear("crossfoam-scrapeDone")
        .then(() => {
          browser.tabs.create({
            url: `/html/vis.html?view=vis&service=${serviceKey}&centralNode=${centralNode}&nUuid=${nUuid}`,
          }).then((results) => {
            // successful opening vis.html
          }, (err) => {
            throw err;
          });
        });
    });

    return Promise.resolve();
  });

};

/*----- Worker Functions -----*/

const workerOverviewNetwork = (event: {
  data: {
    level: number,
    nodes: any,
    limit: number,
  },
}): {level: number, nodes: any} => {

  const nodes = event.data.nodes;

  const simulation = forceSimulation(nodes)
      .force("charge", forceCollide().radius((d) => d.r + 2))
      // TODO: insert the radial force in the middle of the ring ??
      // .force("r", d3.forceRadial(event.data.innerRadius))
      .stop();

  for (let i = 0,
    n = Math.ceil(Math.log(simulation.alphaMin()) / Math.log(1 - simulation.alphaDecay()));
    i < n && i < event.data.limit;
    i += 1) {

    simulation.tick();
  }

  return {
    level: event.data.level,
    nodes,
  };
};

const workerForceNetwork = (event: {data: {nodes: any, edges: any}}): {nodes: any} => {
  const nodes = event.data.nodes;
  const edges = event.data.edges;

  const simulation = forceSimulation(nodes)
      .force("charge", forceManyBody()) // .strength(-300)
      .force("link", forceLink(edges).distance(50).strength(1))
      .force("center", forceCenter(0, 0))
      .force("charge", forceCollide().radius((d) => d.r + 15).strength(1).iterations(10))
      .alphaDecay(1 - Math.pow(0.001, 1 / (300 + Math.pow(nodes.length / 3, 2.3) / 30)))
      .stop();

  for (let i = 0,
    n = Math.ceil(Math.log(simulation.alphaMin()) / Math.log(1 - simulation.alphaDecay()));
    i < n;
    i += 1) {

    simulation.tick();
  }

  return {
    nodes,
  };
};

export { analyseNetwork, buildNetwork, checkupNetwork, cleanupNetwork, estimateCompletion,
         removeNetwork, updateNetworkDictionary, visualizeNetwork, workerOverviewNetwork, workerForceNetwork };
