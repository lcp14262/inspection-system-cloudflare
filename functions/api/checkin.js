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
    
    // 🔍 调试日志：检查是否收到照片数据
    console.log('收到请求数据:', { 
        point_id, 
        has_photo: !!photo, 
        photo_length: photo ? photo.length : 0,
        photo_prefix: photo ? photo.substring(0, 50) : null
    });

    const CHECKIN_POINTS = {
        'A001': { name: '1 号厂房东侧', lat: 31.2304, lng: 120.6773, radius: 50 },
        'A002': { name: '2 号仓库南门', lat: 31.2318, lng: 120.6790, radius: 50 },
        'B001': { name: '化学品存储区入口', lat: 31.2295, lng: 120.6755, radius: 30 },
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
        console.log('环境变量检查:', {
            has_app_id: !!env.FEISHU_APP_ID,
            has_app_secret: !!env.FEISHU_APP_SECRET,
            has_bitable_token: !!env.FEISHU_BITABLE_TOKEN,
            has_table_id: !!env.FEISHU_TABLE_ID
        });
        
        const tokenRes = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ app_id: env.FEISHU_APP_ID, app_secret: env.FEISHU_APP_SECRET }),
        });
        const tokenData = await tokenRes.json();
        console.log('Token 获取结果:', { code: tokenData.code, has_token: !!tokenData.tenant_access_token });
        const token = tokenData.tenant_access_token;

        // 6. 上传照片到云文档
        let fileToken = null;
        if (photo) {
            console.log('开始上传照片...');
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

            const uploadUrl = 'https://open.feishu.cn/open-apis/drive/v1/files/upload_all';
            console.log('上传请求:', { url: uploadUrl, has_token: !!token });
            
            const uploadRes = await fetch(uploadUrl, {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${token}` },
                body: formData,
            });
            const uploadData = await uploadRes.json();
            console.log('附件上传结果:', JSON.stringify(uploadData));
            
            if (uploadData.code === 0) {
                fileToken = uploadData.data.file_token;
                console.log('✅ 附件上传成功，file_token:', fileToken);
            } else {
                console.error('❌ 附件上传失败:', uploadData);
            }
        } else {
            console.log('⚠️ 没有照片数据，跳过上传');
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
        
        // 🔍 调试：显示准备写入的字段
        if (fileToken) {
            fields['现场照片'] = [{ "file_token": fileToken }];
            console.log('准备写入的字段（含照片）:', JSON.stringify(fields));
        } else {
            console.log('准备写入的字段（无照片）:', JSON.stringify(fields));
        }

        const recordUrl = `https://open.feishu.cn/open-apis/bitable/v1/apps/${env.FEISHU_BITABLE_TOKEN}/tables/${env.FEISHU_TABLE_ID}/records`;
        console.log('写入记录请求:', { url: recordUrl, has_token: !!token });
        
        const recordRes = await fetch(recordUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
            body: JSON.stringify({ fields }),
        });
        const recordData = await recordRes.json();
        console.log('写入记录结果:', JSON.stringify(recordData));
        
        if (recordData.code !== 0) {
            throw new Error(recordData.msg || '写入失败');
        }

        return new Response(JSON.stringify({ 
            success: true, 
            message: '打卡成功，数据已存入飞书表格', 
            distance: Math.round(distance*10)/10,
            has_photo: !!fileToken
        }), {
            status: 200, headers: { 'Access-Control-Allow-Origin': '*' }
        });
    } catch (err) {
        console.error('❌ 异常:', err.message);
        return new Response(JSON.stringify({ success: false, message: '写入失败：' + err.message }), {
            status: 500, headers: { 'Access-Control-Allow-Origin': '*' }
        });
    }
}
