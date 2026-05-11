// functions/api/checkin.js
export async function onRequest(context) {
    // 1. 处理预检请求 (CORS)
    if (context.request.method === 'OPTIONS') {
        return new Response(null, {
            status: 200,
            headers: { 
                'Access-Control-Allow-Origin': '*', 
                'Access-Control-Allow-Headers': 'Content-Type, Authorization' 
            }
        });
    }

    // 2. 只接受 POST
    if (context.request.method !== 'POST') {
        return new Response(JSON.stringify({ success: false, message: '方法不允许' }), {
            status: 405, headers: { 'Access-Control-Allow-Origin': '*' }
        });
    }

    // 3. 解析数据
    let body;
    try {
        body = await context.request.json();
    } catch (e) {
        return new Response(JSON.stringify({ success: false, message: '数据格式错误' }), {
            status: 400, headers: { 'Access-Control-Allow-Origin': '*' }
        });
    }

    const { point_id, lat, lng, result, description, photo } = body;
    
    const CHECKIN_POINTS = {
         'A001': { name: '1号大门', area: '芜湖工厂', lat: 31.230834, lng: 118.173690, radius: 100 },
         'A002': { name: '1号大门', area: '合肥工厂', lat: 30.5215, lng: 117.0478, radius: 200 },
         'B001': { name: '1号大门', area: '安庆工厂', lat: 31.329192, lng: 118.367044, radius: 200 },
    };
    const point = CHECKIN_POINTS[point_id];
    if (!point) {
        return new Response(JSON.stringify({ success: false, message: '点位不存在' }), {
            status: 400, headers: { 'Access-Control-Allow-Origin': '*' }
        });
    }

    // 4. 计算距离
    const R = 6371000;
    const dLat = (point.lat - lat) * Math.PI / 180;
    const dLng = (point.lng - lng) * Math.PI / 180;
    const a = Math.sin(dLat/2)**2 + Math.cos(lat*Math.PI/180)*Math.cos(point.lat*Math.PI/180)*Math.sin(dLng/2)**2;
    const distance = R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    
    if (distance > point.radius) {
        return new Response(JSON.stringify({ success: false, message: `位置校验失败！距离 ${distance.toFixed(1)} 米，超出 ${point.radius} 米范围` }), {
            status: 403, headers: { 'Access-Control-Allow-Origin': '*' }
        });
    }
    if (result === '异常' && (!description || description.trim() === '')) {
        return new Response(JSON.stringify({ success: false, message: '异常必须填写问题描述' }), {
            status: 400, headers: { 'Access-Control-Allow-Origin': '*' }
        });
    }

    try {
        // 5. 获取飞书 Token
        const env = context.env;
        const tokenRes = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ app_id: env.FEISHU_APP_ID, app_secret: env.FEISHU_APP_SECRET }),
        });
        const tokenData = await tokenRes.json();
        if (!tokenData.tenant_access_token) {
            throw new Error('获取 Token 失败：' + JSON.stringify(tokenData));
        }
        const token = tokenData.tenant_access_token;

        // ========== 严格飞书官方上传链路：必须上传，不跳过 ==========
        let fileToken = null;
        let uploadError = null;
        
        if (!photo || !photo.startsWith('data:image/')) {
            throw new Error('图片格式不是base64');
        }

        // Base64转二进制
        const base64Data = photo.replace(/^data:image\/[^;]+;base64,/, '');
        const byteCharacters = atob(base64Data);
        const uint8Array = new Uint8Array(byteCharacters.length);
        for (let i = 0; i < byteCharacters.length; i++) {
            uint8Array[i] = byteCharacters.charCodeAt(i);
        }

        const fileName = `inspection_${point_id}_${Date.now()}.jpg`;
        const fileSize = uint8Array.length;

        // 飞书官方必填完整参数（少一个就params error）
        const formData = new FormData();
        formData.append('file', new Blob([uint8Array], { type: 'image/jpeg' }), fileName);
        formData.append('file_name', fileName);
        formData.append('size', fileSize);
        formData.append('type', 'image');
        // 关键：tenant 上传必须 parent_node=root（云盘根目录）
        formData.append('parent_node', 'root');

        // 官方文件上传接口（唯一正确）
        const uploadRes = await fetch('https://open.feishu.cn/open-apis/drive/v1/files/upload_all', {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}` },
            body: formData
        });

        // 捕获非JSON返回，直接抛出明确错误
        const rawText = await uploadRes.text();
        let uploadData;
        try {
            uploadData = JSON.parse(rawText);
        } catch (e) {
            throw new Error(`飞书返回非JSON响应：${rawText}`);
        }

        if (uploadData.code !== 0) {
            throw new Error(`上传API错误：${uploadData.msg || 'params error'}`);
        }

        fileToken = uploadData.data.file_token;
        if (!fileToken) throw new Error('未获取到file_token');
        // ==========================================================

        // 7. 写入多维表格（附件字段严格格式 [{file_token}]）
        const fields = {
            '点位名称': point.name,
            '巡检时间': Date.now(),
            '巡检结果': result,
            'GPS 纬度': lat, 
            'GPS 经度': lng,
            '距点位距离': Math.round(distance*10)/10,
            '问题描述': description || '',
            '处理状态': result === '异常' ? '待处理' : '已解决',
        };
        fields['现场照片'] = [{ file_token: fileToken }];

        const recordUrl = `https://open.feishu.cn/open-apis/bitable/v1/apps/${env.FEISHU_BITABLE_TOKEN}/tables/${env.FEISHU_TABLE_ID}/records`;
        const recordRes = await fetch(recordUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
            body: JSON.stringify({ fields }),
        });
        const recordData = await recordRes.json();
        
        if (recordData.code !== 0) {
            throw new Error(`写入多维表格失败：${recordData.msg}`);
        }

        return new Response(JSON.stringify({ 
            success: true, 
            message: '打卡成功，图片已上传',
            debug: {
                has_photo: true,
                photo_upload: '成功',
                file_token: fileToken,
                record_write: '成功'
            }
        }), {
            status: 200, headers: { 'Access-Control-Allow-Origin': '*' }
        });

    } catch (err) {
        // 任何上传失败直接整体报错，不允许跳过
        return new Response(JSON.stringify({ 
            success: false, 
            message: '打卡失败：图片上传异常 → ' + err.message,
            debug: { upload_error: err.message }
        }), {
            status: 400, headers: { 'Access-Control-Allow-Origin': '*' }
        });
    }
}
