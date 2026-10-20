/* A tiny synthetic PMTiles/MVT neighborhood. No external map data. */
const {project, unproject, tileId} = require('../static/offline-map.js');
const concat = parts => Buffer.concat(parts);
function uint(value) {
  const bytes = [];
  do { const next = value % 128; value = Math.floor(value / 128); bytes.push(next + (value ? 128 : 0)); } while (value);
  return Buffer.from(bytes);
}
function field(number, value, bytes = false) {
  return concat([uint(number * 8 + (bytes ? 2 : 0)), ...(bytes ? [uint(value.length), value] : [uint(value)])]);
}
const string = value => Buffer.from(value, 'utf8');
const signed = value => uint(value < 0 ? -value * 2 - 1 : value * 2);
function shape(type, points) {
  const out = [uint(9), signed(points[0][0]), signed(points[0][1])];
  if (points.length > 1) {
    out.push(uint((points.length - 1) * 8 + 2));
    for (let i = 1; i < points.length; i++) out.push(signed(points[i][0] - points[i - 1][0]), signed(points[i][1] - points[i - 1][1]));
  }
  if (type === 3) out.push(uint(15));
  return concat(out);
}
function layer(name, features) {
  const keys = [], values = [];
  const rows = features.map(({type, points, properties = {}}) => {
    const tags = [];
    for (const [key, value] of Object.entries(properties)) {
      if (!keys.includes(key)) keys.push(key);
      const text = String(value); if (!values.includes(text)) values.push(text);
      tags.push(uint(keys.indexOf(key)), uint(values.indexOf(text)));
    }
    return field(2, concat([field(2, concat(tags), true), field(3, type), field(4, shape(type, points), true)]), true);
  });
  return field(3, concat([field(15, 2), field(1, string(name), true), ...rows,
    ...keys.map(key => field(3, string(key), true)), ...values.map(value => field(4, field(1, string(value), true), true)), field(5, 4096)]), true);
}
function neighborhood(water = true) {
  const z = 14, n = 2 ** z, point = project(121.47, 31.23), x = Math.floor(point.x * n), y = Math.floor(point.y * n);
  const westNorth = unproject(x / n, y / n), eastSouth = unproject((x + 1) / n, (y + 1) / n);
  const center = unproject((x + .5) / n, (y + .5) / n);
  const bounds = [westNorth.lon, eastSouth.lat, eastSouth.lon, westNorth.lat];
  const layers = [layer('earth', [{type: 3, points: [[0,0],[4096,0],[4096,4096],[0,4096]]}]),
    layer('landuse', [{type: 3, points: [[200,300],[1800,300],[1800,1600],[200,1600]], properties: {kind: 'park'}}]),
    layer('roads', [{type: 2, points: [[0,2500],[2000,2200],[4096,2500]], properties: {kind: 'major_road', kind_detail: 'primary', name: 'Review Road'}},
      {type: 2, points: [[1900,0],[1900,2000],[1700,4096]], properties: {kind: 'minor_road', name: 'Quiet Lane'}}]),
    layer('places', [{type: 1, points: [[2200,1000]], properties: {name: 'QA Harbor', kind: 'locality', kind_detail: 'city', population_rank: 10}}]),
    layer('pois', [{type: 1, points: [[1000,1350]], properties: {name: 'QA Park', kind: 'park', min_zoom: 14}}])];
  if (water) layers.splice(1, 0, layer('water', [{type: 3, points: [[3000,0],[4096,0],[4096,4096],[3300,4096],[2850,2000]]}]));
  const tile = concat(layers), directory = concat([uint(1), uint(tileId(z, x, y)), uint(1), uint(tile.length), uint(1)]);
  const header = Buffer.alloc(127); header.write('PMTiles'); header[7] = 3;
  header.writeBigUInt64LE(127n, 8); header.writeBigUInt64LE(BigInt(directory.length), 16);
  header.writeBigUInt64LE(BigInt(127 + directory.length), 56); header.writeBigUInt64LE(BigInt(tile.length), 64);
  header.writeBigUInt64LE(1n, 72); header.writeBigUInt64LE(1n, 80); header.writeBigUInt64LE(1n, 88);
  header[96] = 1; header[97] = 1; header[98] = 1; header[99] = 1; header[100] = z; header[101] = z;
  bounds.forEach((value, index) => header.writeInt32LE(Math.round(value * 1e7), 102 + index * 4));
  header[118] = z; header.writeInt32LE(Math.round(center.lon * 1e7), 119); header.writeInt32LE(Math.round(center.lat * 1e7), 123);
  return {bytes: concat([header, directory, tile]), bounds, center, tile};
}
module.exports = {neighborhood};
