// functions/api/points.js
export async function onRequest(context) {
    const CHECKIN_POINTS = {
       'A001': { name: '1号厂房东侧', area: '芜湖工厂', lat: 31.230834, lng: 118.173690, radius: 100 },
         'A002': { name: '1号大门', area: '合肥工厂', lat: 30.5215, lng: 117.0478, radius: 200 },
         'B001': { name: '1号大门', area: '安庆工厂', lat: 31.7608, lng: 117.2027, radius: 200 },
    };

    const points = Object.entries(CHECKIN_POINTS).map(([id, p]) => ({
        id, ...p, items: ['消防设施', '安全通道', '设备状态'], frequency: '每日',
    }));

    return new Response(JSON.stringify({ success: true, points }), {
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
}
