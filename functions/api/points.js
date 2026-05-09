// functions/api/points.js
export async function onRequest(context) {
    const CHECKIN_POINTS = {
        'A001': { name: '1号厂房东侧', area: '生产车间', lat: 31.2304, lng: 120.6773, radius: 50 },
        'A002': { name: '2号仓库南门', area: '仓储区', lat: 31.2318, lng: 120.6790, radius: 50 },
        'B001': { name: '化学品存储区入口', area: '危化品区', lat: 31.2295, lng: 120.6755, radius: 30 },
    };

    const points = Object.entries(CHECKIN_POINTS).map(([id, p]) => ({
        id, ...p, items: ['消防设施', '安全通道', '设备状态'], frequency: '每日',
    }));

    return new Response(JSON.stringify({ success: true, points }), {
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
}