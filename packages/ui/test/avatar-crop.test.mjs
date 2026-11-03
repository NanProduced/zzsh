import assert from 'node:assert/strict';
import { test } from 'node:test';
import { avatarCropRect } from '../src/avatar-crop-geometry.ts';
test('avatar crop stays square and inside wide/tall images for every zoom and edge',()=>{
 for(const[w,h]of[[640,480],[480,640],[1,1],[8192,4000]])for(const z of [1,2,3,0,9])for(const x of [-9,-1,0,1,9])for(const y of [-1,0,1]){const r=avatarCropRect(w,h,z,x,y);assert(r.size>0&&r.x>=0&&r.y>=0);assert(r.x+r.size<=w+.0001&&r.y+r.size<=h+.0001)}
 assert.deepEqual(avatarCropRect(640,480),{x:80,y:0,size:480});assert.deepEqual(avatarCropRect(640,480,2,1,-1),{x:400,y:0,size:240});
});
test('avatar crop refuses unreadable dimensions and nonfinite controls',()=>{for(const args of [[0,1],[1,-1],[NaN,1],[1,1,Infinity],[1,1,1,NaN]])assert.throws(()=>avatarCropRect(...args))});
