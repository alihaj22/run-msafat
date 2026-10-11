const crypto=require('node:crypto'),policy=require('../dist/student-policy.js');
function validate(b,event){if(event.registrationProfile!=='student')return null;
 const fail=message=>{const e=Error(message);e.status=400;throw e};
 const clean=(key,min,max)=>{const v=String(b[key]??'').trim();if(v.length<min||v.length>max)fail('راجع بيانات الطالب وولي الأمر.');return v};
 const name=clean('name',5,100);if(name.split(/\s+/).length<3)fail('أدخل الاسم الثلاثي.');
 const school=clean('school',2,150),schoolClass=clean('schoolClass',1,40),country=clean('country',2,80),guardianName=clean('guardianName',5,100);
 const birthYear=Number(b.birthYear),year=Number((event.eventDate||event.start).slice(0,4));if(!Number.isInteger(birthYear)||birthYear<year-100||birthYear>year)fail('راجع سنة الميلاد.');
 const nationalId=clean('nationalId',9,9);if(!/^\d{9}$/.test(nationalId))fail('رقم الهوية يجب أن يتكوّن من 9 أرقام.');
 const guardianPhone=String(b.guardianPhone||'').replace(/[\s()-]/g,'');if(!/^\+[1-9][0-9]{7,14}$/.test(guardianPhone)&&!/^0[1-9][0-9]{7,8}$/.test(guardianPhone))fail('راجع هاتف ولي الأمر.');
 if(!['male','female'].includes(b.gender)||!policy.sizes.includes(b.shirtSize))fail('اختر الجنس ومقاس البلوزة.');
 if(b.guardianConsent!==true||b.medicalConsent!==true)fail('موافقة ولي الأمر والإقرار الطبي مطلوبان.');
 if(b.policyVersion!==policy.version)fail('حدّث الصفحة واقرأ التصريح الحالي قبل التسجيل.');
 return {name,school,schoolClass,birthYear,nationalId,country,gender:b.gender,guardianName,guardianPhone,shirtSize:b.shirtSize,guardianConsent:true,medicalConsent:true,smsConsent:b.smsConsent===true,policyVersion:policy.version,declarationText:policy.text,policyHash:crypto.createHash('sha256').update(policy.text).digest('hex'),consentAt:new Date().toISOString()};
}
module.exports={validate,policy};
