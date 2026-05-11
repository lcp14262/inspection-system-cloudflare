// functions/api/checkin.js
export async function onRequest(context) {
    // 1. 处理预检请求 (CORS)
    if (context.request.method === 'OPTIONS') {
        return new Response(null, {
            status: 200,
            headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type' }
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
         'B001': { name: '1号大门', area: '安庆工厂', lat: 31.7608, lng: 117.2027, radius: 200 },
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

        // 6. 上传照片到云文档
        let fileToken = null;
        let uploadError = null;
        
        if (photo) {
            try {
                const base64Data = photo.replace(/^data:image\/\w+;base64,/, "");
                const byteCharacters = atob(base64Data);
                const byteNumbers = new Array(byteCharacters.length);
                for (let i = 0; i < byteCharacters.length; i++) {
                    byteNumbers[i] = byteCharacters.charCodeAt(i);
                }
                const byteArray = new Uint8Array(byteNumbers);
                
                const formData = new FormData();
                formData.append('parent_type', 'bitable_app');
                formData.append('parent_node', env.FEISHU_BITABLE_TOKEN);
                formData.append('file', new Blob([byteArray], { type: 'image/jpeg' }), `photo_${Date.now()}.jpg`);

                const uploadRes = await fetch('https://open.feishu.cn/open-apis/drive/v1/files/upload_all', {
                    method: 'POST',
                    headers: { 'Authorization': `Bearer ${token}` },
                    body: formData,
                });
                const uploadData = await uploadRes.json();
                
                if (uploadData.code === 0) {
                    fileToken = uploadData.data.file_token;
                } else {
                    uploadError = '上传失败：' + JSON.stringify(uploadData);
                }
            } catch (uploadErr) {
                uploadError = '上传异常：' + uploadErr.message;
            }
        }

        // 7. 写入多维表格
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
        
        // 如果有 file_token，写入照片字段
        if (fileToken) {
            fields['现场照片'] = [{ "file_token": fileToken }];
        }

        const recordUrl = `https://open.feishu.cn/open-apis/bitable/v1/apps/${env.FEISHU_BITABLE_TOKEN}/tables/${env.FEISHU_TABLE_ID}/records`;
        const recordRes = await fetch(recordUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
            body: JSON.stringify({ fields }),
        });
        const recordData = await recordRes.json();
        
        if (recordData.code !== 0) {
            throw new Error(recordData.msg || '写入失败');
        }

        // 返回详细调试信息
        return new Response(JSON.stringify({ 
            success: true, 
            message: '打卡成功',
            debug: {
                has_photo: !!photo,
                photo_upload: fileToken ? '成功' : (uploadError || '未上传'),
                file_token: fileToken,
                upload_error: uploadError,
                record_write: '成功',
                fields_written: Object.keys(fields)
            }
        }), {
            status: 200, headers: { 'Access-Control-Allow-Origin': '*' }
        });
    } catch (err) {
        return new Response(JSON.stringify({ 
            success: false, 
            message: '写入失败：' + err.message,
            debug: {
                error: err.message,
                stack: err.stack
            }
        }), {
            status: 500, headers: { 'Access-Control-Allow-Origin': '*' }
        });
    }
}
